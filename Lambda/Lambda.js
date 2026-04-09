import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

// Email service
const ses = new SESClient();
// Secret service
const ssm = new SSMClient();
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const XERO_BANK_ACCOUNT_CODE = process.env.XERO_BANK_ACCOUNT_CODE;
const XERO_ACCOUNT_CODE = process.env.XERO_ACCOUNT_CODE;

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
        const eventType = body.type;

        if (eventType !== 'transaction.created') {
            console.log(`Ignoring event type: ${eventType}`);
            return response(200, { message: `Ignored event type: ${eventType}` });
        }

        const transaction = body.data;
        console.log('Monzo transaction:', JSON.stringify(transaction, null, 2));

        const xeroPayload = mapToXeroBankTransaction(transaction);
        console.log('Xero payload:', JSON.stringify(xeroPayload, null, 2));

        const xeroResult = await sendToXero(xeroPayload);
        console.log('Xero result:', JSON.stringify(xeroResult, null, 2));

        await sendNotificationEmail(xeroPayload);

        return response(200, { message: 'Transaction processed', transactionId: transaction.id });
    } catch (error) {
        console.error('Error processing webhook:', error);
        // Always return 200 to prevent Monzo retry storms
        return response(200, { message: 'Error processing webhook', error: error.message });
    }
};

function mapToXeroBankTransaction(tx) {
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

    await putSSMParameter('xero-api-refresh-token', tokens.refresh_token, true);
    console.log('Xero refresh token updated in SSM');

    return tokens.access_token;
}

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

async function sendNotificationEmail(xeroPayload) {
    if (!NOTIFICATION_EMAIL || !SENDER_EMAIL) {
        console.warn('Email not configured — skipping notification. Set NOTIFICATION_EMAIL and SENDER_EMAIL env vars.');
        return;
    }

    const amount = xeroPayload.LineItems[0].UnitAmount;
    const direction = xeroPayload.Type === 'SPEND' ? 'spent' : 'received';
    const subject = `Monzo: £${amount} ${direction} — ${xeroPayload.Contact.Name}`;
    const bodyText = JSON.stringify(xeroPayload, null, 2);

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
