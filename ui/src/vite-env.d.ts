/**
 * Vite resolves a side-effect CSS import at build time; tsc has no idea what a
 * stylesheet is and fails the whole check on the one line that loads our
 * tokens. Declaring it here keeps `tsc --noEmit` meaningful — a typecheck that
 * always reports one known error is a typecheck nobody reads.
 */
declare module '*.css';
