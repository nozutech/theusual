# The Usual

Digital stamp cards you host yourself. Customers sign up with a QR code, staff scan their card and add a stamp, and the stamp appears on the customer's phone at once. No app to install, no monthly fee and no third party holding your customers' data.

Built for people who aren't computer people: the staff panel is a search box and one big button.

## Try it

You need Docker.

```bash
cp .env.example .env
```

Set `ADMIN_PASSWORD` in `.env`, then run:

```bash
docker compose up --build
```

Then open it on that same computer: `http://127.0.0.1:3000` is the sign-up page and `http://127.0.0.1:3000/panel` is the staff panel. That address only works on the machine running the app. To use it from a phone or a shop, follow [Going live](#going-live) and set `BASE_URL` to your own address.

Print a QR code of that address and put it on the counter.

## Settings

Everything lives in `.env`.

| Setting | What it does |
|---|---|
| `ADMIN_PASSWORD` | Staff panel password. Required, at least 10 characters. |
| `BUSINESS_NAME` | The name customers see. Its first letter becomes the Google Wallet logo. |
| `BASE_URL` | Your public address, without a trailing slash. |
| `BRAND_COLOR` | Card colour. |
| `ACCENT_COLOR` | Stamp and button colour. |
| `STAMPS` | Stamps on a full card, from 3 to 20. |
| `REWARD` | What a full card earns. Leave empty if it earns nothing and starts again. |
| `LANGUAGE` | `en` or `es`. |
| `CONTACT_EMAIL` | Shown on the privacy page. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy. |
| `GOOGLE_WALLET_ISSUER_ID` | Turns on Google Wallet. See below. |
| `GOOGLE_WALLET_KEY_FILE` | Path to the key. Defaults to `secrets/google-wallet.json`. |
| `GOOGLE_WALLET_CLASS` | Name of the card type in your Google account. Defaults to `theusual`. |
| `GOOGLE_WALLET_IMAGES_URL` | Public HTTPS address that serves `/wallet/stamps/`. Defaults to `BASE_URL`. |

## Going live

Compose publishes the app on `127.0.0.1` only. To reach it from the internet, put a reverse proxy or a tunnel with HTTPS in front of it and set `TRUST_PROXY=1`. The panel's camera scanner needs HTTPS.

Your data lives in the `data` Docker volume. Back it up.

The privacy page is a starting point, not legal advice. You are responsible for the data you collect.

## Google Wallet

Optional. Customers on Android get an Add to Google Wallet button, and their pass updates with every stamp, though it can need reopening to show it. Without it, the web card works the same.

Each business uses its own Google account:

1. Sign up as an issuer in the [Google Pay & Wallet Console](https://pay.google.com/business/console) and copy your issuer ID.
2. In [Google Cloud](https://console.cloud.google.com), turn on the Google Wallet API, create a service account and download its JSON key.
3. In the Wallet console, add the service account's email as a user.
4. Save the key as `secrets/google-wallet.json` and set `GOOGLE_WALLET_ISSUER_ID` in `.env`.

If Google Cloud won't let you create the key, your organization is blocking service account keys. Google Workspace accounts do this by default. To allow them in this project only:

1. At the organization level, give yourself the Organization Policy Administrator role (`roles/orgpolicy.policyAdmin`).
2. Switch to the project and open the policy named in the error, usually `iam.managed.disableServiceAccountKeyCreation` or `iam.disableServiceAccountKeyCreation`.
3. Choose **Manage policy**, then **Override parent's policy**. Add a rule with enforcement off and choose **Set policy**.
4. Try again. The change can take up to 15 minutes.

`BASE_URL` must be a public HTTPS address, because Google downloads the stamp images from it. If the app isn't public, set `GOOGLE_WALLET_IMAGES_URL` to a public address that serves those images. A new issuer starts in demo mode: only its test users can save passes until Google approves the account.

Saving a card sends the customer's name, card code and stamps to Google, and the privacy page says so. Google can't delete a pass: when you delete a card, the pass expires and loses the name.

## Status

Early. Apple Wallet passes are planned.

## License

Made by Jotadev ([NozuTech](https://nozutech.dev)). The Usual is under the [GNU AGPL v3](LICENSE) with the additional terms in [NOTICE](NOTICE).

You can use it, change it and install it for others, even for money. Two things to know:

- If people use a modified version over a network, you must offer them its source code.
- The footer credit stays in every copy and modified version.

The NozuTech name and logos aren't covered by the license, and neither are Google's Add to Google Wallet buttons.
