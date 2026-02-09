# Screenshot via Email

![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success)
![Email](https://img.shields.io/badge/Email-Brevo-blue)
![Open Source](https://img.shields.io/badge/Open%20Source-AGPL-brightgreen)

> ⚠️ **AGPL Notice**  
> If you run this software as a network service (including SaaS or hosted services),
> you must make the complete corresponding source code available to users under the
> terms of the GNU AGPL v3.0.

Screenshot via Email is a Cloudflare-based service that captures website screenshots and delivers them via email.  
It uses Cloudflare Email Routing, Brevo’s Email API, and a Cloudflare screenshot worker compatible with `screen-shot.xyz`.

---

## Features

- Capture website screenshots via email requests
- Serverless architecture using Cloudflare Workers
- Email delivery powered by Brevo
- Supports self-hosted screenshot workers

---

## Quick Start

1. Configure Cloudflare Email Routing
2. Deploy the Cloudflare Worker
3. Set the required environment variables
4. Send an email containing a URL
5. Receive a screenshot by email

---

## Environment Variables

The following environment variables are required:

- `BREVO_API_KEY` — Your Brevo API key  
- `BREVO_FROM_EMAIL` — Sender email address used by Brevo  
- `SCREENSHOT_API_BASE` — Base URL of the screenshot API  

Example:

    BREVO_API_KEY=your_brevo_api_key
    BREVO_FROM_EMAIL=sender@example.com
    SCREENSHOT_API_BASE=https://your-screenshot-worker-url

---

## Screenshot API

This project uses a screenshot API compatible with  
[screen-shot.xyz](https://api.screen-shot.xyz).

You may:

- Use the public API, or
- Deploy your own Cloudflare Worker using  
  https://github.com/Hassanrkbiz/cloudflare-screenshot-api  
  and configure `SCREENSHOT_API_BASE` with your worker’s URL

---

## How It Works

1. Incoming emails are handled by Cloudflare Email Routing
2. Requests are processed by a Cloudflare Worker
3. Screenshots are generated via the screenshot API
4. Images are sent to recipients using Brevo’s Email API

---

## Tech Stack

- Cloudflare Workers
- Cloudflare Email Routing
- Brevo Email API
- screen-shot.xyz compatible screenshot API

---

## Disclaimer

This project is provided as-is for educational and experimental purposes.
No warranty is provided, and the authors are not responsible for misuse,
data loss, or service interruptions.

---

## Contributing

Contributions, issues, and feature requests are welcome.

By contributing to this project, you agree that your contributions will be
licensed under the GNU Affero General Public License v3.0.

---

## Security

If you discover a security vulnerability, please report it responsibly.
Do not open a public issue.

Contact: security@rendermail.us.kg

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

You are free to use, modify, and distribute this software under the terms of the AGPL-3.0.  
If you run a modified version of this software as a network service, you must make the
source code available to users.

See the [LICENSE](./LICENSE) file for full details.

---

## Project

Live project:  
https://www.RenderMail.us.kg

---

## Logo

<img width="1280" height="583" alt="RenderMail logo" src="https://github.com/a353121/screenshots-via-email/blob/main/RenderMail.logo.png" />
