# monzo-xero-integration
A template for creating a simple, super low-cost Monzo-Xero integration in AWS

## Setup steps

1. AWS setup (Create Lambda and API Gateway)
2. Monzo API setup (Create Monzo webhook)
3. Xero API setup

Feel free to use the Postman collection in this repo to get started, however, both Monzo and Xero have extensive API docs publically available if you want to take it further.

You can also test the Lambda directly from Postman.

### 1. AWS setup
Use the SAM template to create the AWS resources you need, or to use as a baseline.

### 2. Monzo API setup
Official API docs:
    https://docs.monzo.com/#acquire-an-access-token

First, you'll need an auth token, which you can get from https://developers.monzo.com/api/playground.
Follow the link in the email you received and copy the auth token.

Use this to update your monzo_auth_token variable.

To create a webhook, you'll need the account for which you want events to be sent, and a destination URL (our Lambda).

List your accounts and copy the account_id of the account you want to create a webhook for.
For the URL, use the AWS API Gateway Invoke URL, which looks like this https://someidentifier.execute-api.eu-north-1.amazonaws.com, along with the route for your resource (e.g. MonzoWebhook).

### 3. Xero API setup
Official API docs:
    https://developer.xero.com/documentation/api/accounting/banktransactions

Official Postman collection:
    https://developer.xero.com/documentation/sdks-and-tools/tools/postman

You'll need to get the xero-tenant-id for your organisation, as well as the username (client_id) and secret to make subsequent auth requests.

You can swap your tenant ID to switch between organisations, including the Demo Org provided by Xero.

