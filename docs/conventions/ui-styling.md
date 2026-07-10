# UI Styling Convention

Use Tailwind CSS for any HTML or React styling surface.

## Tailwind

- Prefer Tailwind utility classes over handwritten CSS.
- Keep visual test fixtures deterministic by compiling local Tailwind CSS with `pnpm build:visual-css`.
- Avoid remote CSS or CDN dependencies in tests.

## shadcn/ui

If a React operator UI is introduced, use shadcn/ui components before custom markup.

Required workflow:

1. Run `pnpm dlx shadcn@latest info --json` to inspect project context.
2. Run `pnpm dlx shadcn@latest docs card table badge button alert tabs` before using those components.
3. Add components with `pnpm dlx shadcn@latest add card table badge button alert tabs`.
4. Review generated files before committing.

Use shadcn `Card`, `Table`, and `Badge` for dashboard-style status views. Use `Button` variants rather than custom button classes. Use semantic tokens and `gap-*`; avoid raw color overrides and `space-y-*`.

## Google Sheets Exception

Google Sheets is the MVP operator UI and cannot use Tailwind or shadcn directly. Use native Sheets tables for headers, filters, and alternating row bands. Keep operator columns decision-first and limited to the documented projection; keep implementation metadata in developer tabs. Apply tab order, column widths, hidden obsolete columns, and table ranges deterministically through repository writes.
