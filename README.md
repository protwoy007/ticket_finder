Setup Video
https://youtu.be/EWoXsf-7Xak

# Ticket Finder

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A free Chrome extension for the Bangladesh Railway e-ticket website (eticket.railway.gov.bd).

Sometimes a seat from Dhaka to Khulna is sold out, but seats from Dhaka to Jessore and from Jessore to Khulna are free. The website only shows one pair of stations at a time, so finding this by hand takes a lot of searching. Ticket Finder does the searching for you. It checks every stop of a train and shows you the ways to split your journey into several tickets.

You do not need an account, a key, or any technical knowledge. Nothing is sent anywhere except the normal requests the railway website itself makes.

Works in Google Chrome, Microsoft Edge, Brave and other Chromium browsers on a computer. It does not work on phones.

---

## How to install (step by step)

1. **Unzip the file.** Right-click `ticket-finder.zip` and choose "Extract All" (Windows) or double-click it (Mac). You will get a folder named `ticket-finder`. Keep this folder somewhere permanent, such as Documents. If you delete it, the extension stops working.
2. **Open the extensions page.** In Chrome, type `chrome://extensions` in the address bar and press Enter. In Edge, type `edge://extensions`.
3. **Turn on Developer mode.** Find the switch labeled "Developer mode" (top right in Chrome, bottom left in Edge) and turn it on.
4. **Load the extension.** Click **Load unpacked**. In the window that opens, choose the `ticket-finder` folder, the one that contains a file called `manifest.json`. Then click "Select Folder".
5. **Check it worked.** "Ticket Finder" should now appear in your list of extensions with its switch turned on.

If Chrome shows a warning about developer mode extensions when you restart it, just close the message. It is normal for extensions installed this way.

### Updating or fixing it later

After you change or replace any file in the folder, go back to the extensions page, click the small circular refresh arrow on the Ticket Finder card, then reload the railway website.

### Removing it

On the extensions page, click **Remove** on the Ticket Finder card.

---

## How to use it

1. Go to **eticket.railway.gov.bd** and **log in**.
2. **Search for any train once**, the way you normally do. This is required. The extension uses your login from this search and never sees your password.
3. Click the **Ticket Finder** button at the bottom right of the page. A panel opens.
4. Fill in **From**, **To**, **Date** and **Class**.
5. Click **Scan all trains**. Ticket Finder checks every train on your route and lists the best way to travel on each one. The best train is marked with a star.
6. Wait while it scans. A progress bar shows the exact clock time the scan will finish and the time left. It is slow on purpose, so the railway website does not block you.
7. Read the list. Each train shows its leave time, the number of tickets, the total fare and the seats left. Click a train to open its details:
   - **Seats along the line** shows how many seats are free on each stretch between two stops.
   - **All station pairs** is a colored table. Darker green means more seats. Yellow means 3 or fewer. Striped means sold out. A blue outline means one ticket covers your whole trip.
   - **Ways to travel** lists the options. Click one to see its tickets marked on the table.
8. Click the copy button to copy the top 3 trains so you can paste them into a note or message.
9. Buy each ticket yourself on the railway website. Seats can sell out at any moment, so buy quickly.

### How to read the route line

Each route is drawn as a line from your start to your end:

| What you see | Meaning |
|---|---|
| Green bar with a ticket icon and a number | A ticket you buy. The number is the order of purchase. |
| Red bar | Sold out between those two stations. No ticket is available there. |
| Orange circle with arrows | A station where you change to your next ticket and seat. |
| Green bar with a seat icon | Seats are free on that stretch, and the number is how many. |

When a train has no way to travel, its line shows where it is sold out in red.

### Saved routes

Press the star button to keep your current From, To and Class. It appears as a button at the top of the panel. Click it any time to fill those fields again, then pick a date and scan. Click the **x** next to it to remove it. Up to 12 routes are kept, only in your own browser.

---

## Good to know

- Routes are ranked by the fewest tickets.
- A train that already has a seat for your whole trip is marked as a direct seat and is not scanned. Other trains are scanned only between your From and To, which keeps the scan shorter. Scanning many trains can still take a few minutes.
- Only the stops where a train really stops are scanned. Stations a train skips are removed automatically.
- Ticket Finder only reads seat information. It does not buy tickets for you.
- Seat numbers are fetched fresh on every scan and can change before you buy.
- Your last search, saved routes and each train's stop list are remembered in your own browser only.
- The extension icon appears on the extensions page, in the panel header and on the launcher button.

## Problems and fixes

| What you see | What to do |
|---|---|
| "Not ready yet. Log in, search for a train..." | Log in on the railway site, search for a train once, then try again. |
| "Session problem" | Refresh the page, search once, then try again. |
| The panel does not appear | Reload the railway page. If it still does not appear, refresh the extension on the extensions page. |
| A train shows a red cross and a message | That train could not be scanned. Press **Scan all trains** again. |
| The scan is slow | This is normal. Requests are spaced out to avoid being blocked. |

## For developers

Files: `manifest.json` (Manifest V3), `core.js` (route search, dates, parsing), `stations.js` (station hints), `app.js` (requests and interface). The scripts run on `https://eticket.railway.gov.bd/*` and need no special permissions.

## License

Copyright (c) 2026 protwoy.

Ticket Finder is released under the [MIT License](LICENSE). You may use, copy, modify and share it, as long as the copyright notice and the license text stay with it. The software comes without any warranty.

## Disclaimer

Ticket Finder is an independent project. It is not made, endorsed or supported by Bangladesh Railway or the eticket.railway.gov.bd website. It only reads seat information that the website already shows you. Use it at your own risk and follow the website's terms of use.
