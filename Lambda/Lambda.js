import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

// Email service
const ses = new SESClient();
// Systems manager parameter store
const ssm = new SSMClient();
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const XERO_BANK_ACCOUNT_CODE = process.env.XERO_BANK_ACCOUNT_CODE;
const XERO_ACCOUNT_CODE = process.env.XERO_ACCOUNT_CODE;
const ACCESS_TOKEN_TTL_BUFFER = 300000;

export const handler = async (event) => {
    console.log('Received event');
    let xeroPayload;

    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
        const eventType = body.type;

        if (eventType !== 'transaction.created') {
            console.log(`Ignoring event type: ${eventType}`);
            return response(200, { message: `Ignored event type: ${eventType}` });
        }

        const transaction = body.data;
        xeroPayload = mapToXeroBankTransaction(transaction);

        // xeroPayload does not contain PII
        await sendToXero(xeroPayload);

        return response(200, { message: 'Transaction processed', transactionId: transaction.id });
    } catch (error) {
        await sendNotificationEmail(error, xeroPayload);
        // Always return 200 to prevent Monzo retry storms
        return response(200, { message: 'Error processing webhook', error: error.message });
    }
};

// #region Transaction mapper

function mapToXeroBankTransaction(tx) {
    if (tx == null){
        throw new Error('Invalid transaction: missing transaction data');
    }

    if (!Number.isFinite(tx.amount)) {
        throw new Error(`Invalid transaction: amount must be a valid number: ${tx.amount}`);
    }

    if (!tx.merchant?.name?.trim()) {
        throw new Error('Invalid transaction: merchant name must not be empty or whitespace');
    }

    const direction = tx.amount < 0 ? 'SPEND' : 'RECEIVE';
    const absoluteAmount = Math.abs(tx.amount) / 100;
    const contactName = tx.merchant?.name || tx.description || 'Unknown';
    const date = tx.created ? tx.created.substring(0, 10) : new Date().toISOString().substring(0, 10);

    return {
        Type: direction,
        Contact: {
            Name: contactName,
        },
        Date: date,
        CurrencyCode: tx.currency,
        BankAccount: {
            Code: XERO_BANK_ACCOUNT_CODE,
        },
        Reference: tx.id,
        LineItems: [
            {
                Description: buildLineItemDescription(tx),
                UnitAmount: absoluteAmount.toFixed(2),
                AccountCode: XERO_ACCOUNT_CODE,
            },
        ],
    };
}

function buildLineItemDescription(tx) {
    const parts = [tx.description];
    if (tx.merchant?.name && tx.merchant.name !== tx.description) {
        parts.push(`Merchant: ${tx.merchant.name}`);
    }
    if (tx.category) {
        parts.push(`Category: ${tx.category}`);
    }
    return parts.filter(Boolean).join(' | ');
}

// #endregion

// #region Token management

async function getSSMParameter(name, withDecryption = false) {
    const command = new GetParameterCommand({
        Name: `/${name}`,
        WithDecryption: withDecryption,
    });
    const result = await ssm.send(command);
    return result.Parameter.Value;
}

async function putSSMParameter(name, value, secure = false) {
    const command = new PutParameterCommand({
        Name: `/${name}`,
        Value: value,
        Type: secure ? 'SecureString' : 'String',
        Overwrite: true,
    });
    await ssm.send(command);
}

async function getXeroAccessToken() {
    const accessToken = await getSSMParameter('xero-access-token', true);
    const expiresAt = Number(await getSSMParameter('xero-access-token-expires-at'));

    console.log(`Access token expires at: ${new Date(expiresAt).toString()}`);

    if (accessToken && Date.now() < expiresAt - ACCESS_TOKEN_TTL_BUFFER) {
        console.log('Xero access token valid — skipping refresh');
        return accessToken;
    }

    const clientId = await getSSMParameter('xero-api-username');
    const clientSecret = await getSSMParameter('xero-api-password', true);
    const refreshToken = await getSSMParameter('xero-api-refresh-token', true);
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });

    if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
           throw new Error(`Xero token refresh failed (${tokenResponse.status}): ${errorBody}`);
    }

    const tokens = await tokenResponse.json();
    console.log('Xero access token refreshed');

    await putSSMParameter('xero-access-token', tokens.access_token, true);
    await putSSMParameter('xero-api-refresh-token', tokens.refresh_token, true);

    // expires_in always expressed in seconds according to Xero's API docs
    const tokenExpiry = tokens.expires_in * 1000;
    await putSSMParameter('xero-access-token-expires-at', `${Date.now() + tokenExpiry}`);

    console.log('Xero refresh token updated in SSM');

    return tokens.access_token;
}

// #endregion

async function sendToXero(xeroPayload) {
    const accessToken = await getXeroAccessToken();
    const tenantId = await getSSMParameter('xero-api-tenant-id-demo');

    const xeroResponse = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'xero-tenant-id': tenantId,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(xeroPayload),
    });

    if (!xeroResponse.ok) {
        const errorBody = await xeroResponse.text();
        throw new Error(`Xero API call failed (${xeroResponse.status}): ${errorBody}`);
    }

    return await xeroResponse.json();
}

async function sendNotificationEmail(error, xeroPayload) {
    if (!NOTIFICATION_EMAIL || !SENDER_EMAIL) {
        console.warn('Email not configured — skipping notification. Set NOTIFICATION_EMAIL and SENDER_EMAIL env vars.');
        return;
    }

    const amount = xeroPayload.LineItems[0].UnitAmount;
    const direction = xeroPayload.Type === 'SPEND' ? 'spent' : 'received';
    const subject = `Monzo-Xero - Failed to send transaction: £${amount} ${direction} — ${xeroPayload.Contact.Name}`;
    const bodyText = [
        `Error: ${error.message}`,
        error.stack ? `Stack:\n${error.stack}` : '',
        `Xero Payload:\n${xeroPayload ? JSON.stringify(xeroPayload, null, 2) : 'No payload available'}`,
    ]
        .filter(Boolean)
        .join('\n\n');

    const command = new SendEmailCommand({
        Source: SENDER_EMAIL,
        Destination: {
            ToAddresses: [NOTIFICATION_EMAIL],
        },
        Message: {
            Subject: { Data: subject },
            Body: {
                Text: { Data: bodyText },
            },
        },
    });

    await ses.send(command);
    console.log('Notification email sent');
}

function response(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}
