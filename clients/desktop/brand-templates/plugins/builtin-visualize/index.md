# {{BRAND_DISPLAY_NAME}} Visualize

How to show effective visuals in a {{BRAND_DISPLAY_NAME}} chat reply with the
ShowVisual and PreviewVisual tools: which display fits the data, which
libraries load, how to match the app theme, and how to check the result.

The tools must be available in the chat for this plugin to be useful. They are
behind the chat visuals feature and carry a brand prefix that differs by
engine.

## Skills

- [visualize](skills/visualize/SKILL.md) — decide whether a visual is the
  right answer, pick the display, build it, check it, and show it.

## References

- [choosing-a-display.md](references/choosing-a-display.md) — the display
  that fits each kind of data, with a default and advanced options.
- [theme.md](references/theme.md) — the theme variables, how to color data
  with them, and the theme kit for canvas libraries.
- [libraries.md](references/libraries.md) — charting, diagram, and table
  libraries that load from the allowed CDNs, pinned with integrity hashes.
- [platform.md](references/platform.md) — what the frame allows and blocks,
  sizing, timing, images, and how to read a preview.
- [recipes.md](references/recipes.md) — an index of the example documents.

## Assets

- [starter.html](assets/starter.html) — an empty visual with the theme kit.
- [recipes/](assets/recipes/) — complete example documents to adapt.

## Runtime dependencies

None. This plugin contains guidance and example documents only: no MCP, app,
hook, or authentication configuration. The libraries it lists load from public
CDNs inside the visual's own sandboxed frame.
