# Google Calendar API Setup Guide

To enable Google Calendar booking capabilities for the agent, follow these steps to set up the Google Workspace integration for local testing.

## Prerequisites
You need a Google Cloud account. Go to the [Google Cloud Console](https://console.cloud.google.com/).

## 1. Create a Project and Enable the API
1. Create a new Google Cloud Project (or select an existing one).
2. Go to **APIs & Services > Library**.
3. Search for **Google Calendar API** and click **Enable**.

## 2. Set Up the OAuth Consent Screen
1. Go to **APIs & Services > OAuth consent screen**.
2. Choose **External** (if you don't have a Workspace organization) and click **Create**.
3. Fill in the required fields (App name, support email, developer contact email).
4. For **Scopes**, click "Add or Remove Scopes" and add:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.readonly`
5. For **Test Users**, make sure to add the Google account you will be using to test the integration (e.g., your personal gmail). This is required if the app is in "Testing" status.
6. Click **Save and Continue** until finished.

## 3. Create Credentials
1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials** -> **OAuth client ID**.
3. Select **Web application** as the application type.
4. Set the **Authorized redirect URIs** to your local testing environment:
   - `http://localhost:3000` (or whichever URL you use for local testing).
5. Click **Create**.
6. You will receive a **Client ID** and **Client Secret**.

## 4. Local App Setup
To perform local development and testing, you can use a Service Account. Wait, for user-specific calendar modifications (like checking a specific business calendar), you generally either use a Service Account with domain-wide delegation (for Google Workspace) or you obtain an OAuth token for a specific user and refresh it.

### Alternative (Easiest for local bots): Service Account
If you just want the bot to manage a specific calendar that you own:
1. In the Google Cloud Console, go to **Credentials > Create Credentials > Service account**.
2. Create the service account and generate a JSON key.
3. Share your target Google Calendar with the Service Account email address (give it "Make changes to events" permissions).
4. Save the downloaded JSON file as `service-account.json` in the root of your project.

### Supported Gemini Function Calling
This applet comes with default mocked function calling for Google Calendar events (`checkCalendarAvailability` and `bookCalendarSlot`). The local `server.ts` handles these function calls and provides fake calendar events for testing purposes!

1. Try saying: "Check availability for June 6th"
2. Try saying: "Book a slot for Raffe at 10 AM on June 6th"

The Gemini model will automatically trigger the respective tool handler and fake the booking locally.
