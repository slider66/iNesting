<img src="https://deepnest.io/img/logo-large.png" alt="iNesting" width="250">

# iNesting

**iNesting** is an updated and improved fork of [Deepnest](https://github.com/Jack000/Deepnest) — a fast, robust nesting tool for laser cutters and other CNC tools.

## Credits

This project is based on the outstanding work of:

- **[Jack Qiao](https://github.com/Jack000)** — original author of [Deepnest](https://github.com/Jack000/Deepnest) and [SVGnest](https://github.com/Jack000/SVGnest)
- **SVGnest** — the browser-based nesting engine that Deepnest was built upon

All original code is licensed under GPLv3. This fork maintains that license and builds upon the original algorithms with improvements to DXF compatibility, line grouping detection, and general stability.

## What's new in iNesting

- Local DXF parsing (no external server dependency)
- Improved line/segment grouping detection
- Updated dependencies
- Bug fixes from the original codebase

## Original features (from Deepnest)

- Nesting engine with speed-critical code written in C
- Merges common lines for laser cuts
- Support for DXF files
- New path approximation feature for highly complex parts

## Download

Clone and run locally:

```
npm install
npm start
```

## License

GPLv3 — see [LICENSE.txt](main/LICENSE.txt)
