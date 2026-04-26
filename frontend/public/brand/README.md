# Rivera brand assets

Drop the official Rivera logo PNG here as `rivera-logo.png`.

```
public/
└── brand/
    └── rivera-logo.png    ← place file here
```

## How it's consumed

The path is centralised in `src/lib/brand.ts`:

```ts
export const RIVERA_LOGO_SRC = "/brand/rivera-logo.png";
```

The `<RiveraLogo />` component (`src/components/layout/RiveraLogo.tsx`)
renders this PNG inside a fixed-size `<img>` with `object-contain`, so:

- **Icon-only PNG** — render at `h-9 w-9` (default). The sidebar keeps
  the "Rivera" wordmark + "Property Accounting" subtitle next to it.
- **Full lockup PNG** (icon + wordmark in one image) — pass a wider
  className like `h-9 w-[10rem]`. The text labels next to the logo
  in `Sidebar.tsx` can be removed if they would duplicate the wordmark
  in the PNG.

## Replacing the logo

Swap the file in-place. No code changes needed unless you're switching
between icon-only and full-lockup variants (in which case adjust the
sidebar label visibility).
