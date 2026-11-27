---
title: Help improve this site
description: How to fix a typo, add notes about your radio or send a photo, without programming.
---

Anyone can improve these pages. You do not need to know programming or any special tool.
There are two ways, and both end with a maintainer looking over the change before it goes
live.

## Tell us what to change

This is the easiest way, and the best one for sending a photo.

1. Open the
   [suggestion form](https://github.com/turnrye/openrtx-web-flasher/issues/new?template=docs-suggestion.yml).
   It asks you to sign in to GitHub; an account is free.
2. Say which page, and what should change, in your own words.
3. Drag any photos onto the text box.
4. Press **Submit new issue**.

A maintainer makes the change from what you wrote.

## Edit the page yourself

Every page has an **Edit page** link at the bottom.

1. Click **Edit page**. Sign in to GitHub if it asks.
2. The first time, GitHub says you need to "fork this repository". Press the green
   button: it gives you your own copy to change, and nothing on the live site is touched.
3. Change the text. Pages are written in Markdown: plain text, with `#` in front of a
   heading and `-` in front of each item of a list. The **Preview** tab shows the result.
4. Press **Commit changes...**, say in a few words what you changed, then **Propose
   changes**, then **Create pull request**.

That last button sends your change to the maintainers. You can close the tab; GitHub
emails you when somebody answers.

### The lines at the top of a page

Each page starts with a few lines between two `---` marks, like this:

```yaml
---
title: Tytera MD-UV380
---
```

Leave the marks in place and keep `title:` on its own line. The title is what the menu
and the top of the page show.

### Adding a photo

Photos of a radio live in the same folder as its page. On GitHub, open that folder, press
**Add file**, then **Upload files**, and drag the photo in. Then put it on the page with
a line like:

```md
![The programming cable plugged into the side of the radio](./cable.jpg)
```

The words in the square brackets describe the photo for people who cannot see it.

## What happens next

- A maintainer reads the change, and may ask a question or adjust the wording.
- When it is accepted, the site rebuilds by itself and the change is live a few minutes
  later.
- Your GitHub name stays on the change.

## Without a GitHub account

Post the correction or the photo where the project talks: see [get in touch](../get_in_touch/).
Somebody there can file it for you.

## Where the pages come from

Most pages of this site are still kept in the OpenRTX website's repository,
[OpenRTX/openrtx.github.io](https://github.com/OpenRTX/openrtx.github.io), and copied
here each time the site is built. Their **Edit page** link takes you there, and the steps
are the same. The flasher's own pages are kept with the flasher.
