# Privacy policy for D2L Course Downloader

**Effective date:** October 21, 2026

D2L Course Downloader is a Chrome extension that downloads files from a D2L Brightspace course you are already signed into. It saves those files on your computer, in folders that follow the course content page.

This policy describes what the extension does with information. It does not cover Brightspace, your school, or Chrome. Those services have their own policies.

## What we do not do

The developer does not receive, collect, or store your information on a server. The extension has no account, no analytics, and no advertising. It does not sell or share information with anyone. It does not read your browsing history, location, passwords, or messages.

The only website the extension requests data from is the Brightspace site already open in your browser.

## Information used on your device

When you scan a course, the extension reads that course from the signed-in Brightspace page. That includes the course name, the course id in the page address, module and topic titles, and the addresses and names of files and links in the course. It uses this only to show the file list and to download the items you leave selected.

Downloads use your existing Brightspace sign-in. Chrome sends that site's cookies with those requests. The extension also reads the `d2lSecureSessionVal` cookie and sends it back to Brightspace as the `X-Csrf-Token` header, which is what Brightspace requires for its own requests. That value is not saved by the extension and is not sent anywhere else.

Files are saved only where you choose: a folder you pick, or your Downloads folder. A text file named `links.txt` is added when you leave link items selected. It contains those link titles and addresses so you still have a record of items that are not files.

## Information stored on your device

The extension stores the following in Chrome's local storage and IndexedDB, on your computer:

- The name of the folder you picked, and Chrome's permission to write to that folder
- A list of files already saved, including each file's Brightspace address, local path, size, and the `ETag` or last-modified value Brightspace sent, so unchanged files can be skipped
- An unfinished download, including the course name, course id, selected file names and addresses, and how far the download got, so you can resume it
- Whether you have dismissed the first-run note about Chrome's save prompt

While the browser is open, it also remembers the current scan, which course tab it belongs to, and download progress. That session data is dropped when the browser closes. The saved scan is also dropped when you leave that course.

Uninstalling the extension removes this stored data. Files already written to a folder stay there until you delete them.

## Permissions

- **Active tab and scripting:** read the open Brightspace course when you start a scan or download
- **Downloads:** save files into your Downloads folder when you do not pick another folder
- **Storage:** keep the settings and progress described above
- **Offscreen:** keep a download going after the popup closes
- **Site access:** download course files from your school's Brightspace address. Schools use different addresses, so the extension is allowed to request `http` and `https` pages. It uses that access for the course you are downloading, not to browse unrelated sites.

## Children

The extension is not directed at children under 13, and the developer does not knowingly collect personal information from anyone.

## Changes

If this policy changes, the new version will be posted at this same address with a new effective date.

## Contact

Questions about this policy can be sent by opening an issue at <https://github.com/harshilparekh874/d2l-downloader/issues>.
