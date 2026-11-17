# Photobooth

A browser photobooth that works on iPhone, iPad and Mac. Pick a template, take the photos, save the result.

## Making templates in Canva

1. Make your design at the size you want the final image (e.g. 600 x 1800 px for a strip, 1200 x 1800 px for a 4x6).
2. Put a rectangle wherever a photo should go, then **delete it** so that area is empty.
3. Download as **PNG** with **Transparent background** ticked (needs Canva Pro, or use a free remover like remove.bg after exporting).

The app finds the transparent gaps on its own. Each gap = one photo, taken in order top-to-bottom, left-to-right.

## Adding templates

Two ways:

- **For every device:** drop the PNG into `public/templates/`, add the filename to `public/templates/templates.json`, then redeploy.
- **Just on this device:** tap "+ Add template" in the app. It's saved in that browser only.

## Running it locally

```
npx serve public
```

The camera only works on `localhost` or `https://`, so to test on your phone you'll need to deploy (below).

## Hosting on Firebase (free)

```
npm install -g firebase-tools
firebase login
firebase init hosting
```

When asked:
- Use an existing project or create one
- Public directory: `public`
- Single-page app: `No`
- Overwrite `public/index.html`: **No**

Then:

```
firebase deploy
```

You'll get a link like `https://your-project.web.app`. Open it on any device.

Tip: on iPhone/iPad, open the link in Safari, tap Share > Add to Home Screen so it opens full screen like an app.

## Saving to the gallery

- **iPhone / iPad:** tap Save, then "Save Image" in the share sheet. It goes straight into Photos.
- **Mac:** Safari shows the share sheet (choose "Add to Photos"). Other browsers download the file to Downloads.

## Settings

At the top of `app.js`:
- `COUNTDOWN_SECONDS`: seconds before each photo
- `MIRROR`: flip photos like a mirror
- `OUTPUT_TYPE`: `image/jpeg` (smaller) or `image/png`
