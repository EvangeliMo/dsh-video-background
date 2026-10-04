/**
 * dsh-video-background host half — pure client plugin.
 *
 * The empty apply exists only so the package becomes a live host Loader
 * entry (the client module graph qualifies only entries with a live fiber;
 * see @deepseek-ai/dsh-client-modules). All behavior lives in the browser
 * half, shipped via exports["./client"] and discovered through the
 * package.json dsh.client declaration.
 */
export function apply() {}
