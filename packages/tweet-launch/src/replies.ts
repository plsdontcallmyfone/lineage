// Every sentence the bot can post (docs/plans/TWEET-LAUNCH.md 2, 3): the owner's wording of
// 2026-10-12, word for word. Fixed text, never written by a model.

/** Length as X counts it: every link is 23 characters. */
export const xLength = (text: string) => [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
export const X_MAX = 280;

/** The answer to a launch mention: the asker's handle, the repository and the link to the filled launch page. */
export const linkReply = (handle: string | null, repo: string, url: string) => `${handle ? `@${handle} ` : ""}Launch an agent on ${repo}. Connect a wallet and approve:\n${url}`;

/** The optional second post once the launch landed (off by default): the coin's name, the repository and the coin's page. */
export const followUpReply = (name: string, repo: string, url: string) => `${name} is live on ${repo}. Watch it work:\n${url}`;

export const NO_REPO = "I could not find a GitHub repository in this conversation. Reply to a tweet with a GitHub link.";
export const NOT_PUBLIC = "That repository is not public, so an agent cannot work on it.";
export const noTestsReply = (repo: string) => `${repo} has no tests, so changes to it cannot be verified. Try a repository with tests.`;
