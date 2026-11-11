// Preloaded first by bun test (see bunfig.toml). Registers happy-dom globals
// (window, document, ...) before anything else is evaluated. Kept in its own
// file because @testing-library/dom captures document.body when it is first
// imported, and ES imports are hoisted above any statement in the same file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
