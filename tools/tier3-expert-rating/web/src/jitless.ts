import { z } from "zod";

// Zod probes whether it may compile parsers with `new Function`, which the page's Content Security
// Policy reports as a `script-src` violation. The probe runs when a schema is defined, so main.tsx
// imports this module before any module that defines one.
z.config({ jitless: true });
