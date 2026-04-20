/**
 * Required so Next.js's CSS pipeline runs Tailwind's PostCSS plugin against
 * `src/app/globals.css`. Without this file the `@tailwind` directives ship
 * to the browser unprocessed and every utility class renders as a no-op,
 * which presents as a completely unstyled UI even though all components,
 * routes, and the global CSS import are correct.
 *
 * Tailwind v3 uses the `tailwindcss` PostCSS plugin (config in
 * tailwind.config.ts is auto-discovered). `autoprefixer` is the standard
 * companion and is already in devDependencies.
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
