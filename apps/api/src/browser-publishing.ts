import type { BrowserContext, Locator, Page } from "playwright";
import { POST_CHARACTER_LIMIT } from "@threadflow/shared";
import {
  authenticatedCookies,
  decodeBrowserSessionJSON,
  filterSessionStorage,
  inspectBrowserContext,
  type BrowserIdentity,
  type BrowserStorageState,
} from "./browser-sessions.js";
import { ProviderError, type PublishInput } from "./providers.js";

import { openProxyContext, type ProxyOwner } from "./account-proxies.js";
import { HttpError } from "./http.js";

const HOME_URL = "https://www.threads.com/";
const MIN_PUBLICATION_INTERVAL = 8000;
// Give Threads a short, bounded propagation window before the one profile
// navigation used for confirmation. The provider never performs a stream of
// reloads (or any simulated browsing) while waiting for the new post.
const CONFIRMATION_PROPAGATION_DELAY_MS = 3000;
const UNCERTAIN_MESSAGE =
  "Threads did not confirm the new post. Check your Threads profile before publishing this text again.";

export interface BrowserPublishInput extends PublishInput {
  username: string;
  userId: string;
  socialAccountId: string;
  loadSession?: () => Promise<string>;
  saveSession?: (sessionJSON: string) => Promise<void>;
}
export interface BrowserPostObservation {
  url: string;
  author: string;
  text: string;
  publishedAt: string | null;
}
export interface PublishingWindow {
  verifyIdentity(expected: BrowserIdentity): Promise<BrowserIdentity>;
  readPosts(username: string, navigate?: boolean): Promise<BrowserPostObservation[]>;
  prepare(content: string, username: string): Promise<void>;
  send(content: string, username: string): Promise<void>;
  snapshot(): Promise<BrowserStorageState>;
  close(): Promise<void>;
}
interface PublishingDependencies {
  open(state: BrowserStorageState, owner?: ProxyOwner): Promise<PublishingWindow>;
  now(): number;
  pause(milliseconds: number): Promise<void>;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/[\u200b\ufeff]/g, "").trim();
}
function postURL(url: string, username: string): string | null {
  try {
    const parsed = new URL(url, HOME_URL);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      !["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(parsed.hostname)) return null;
    const match = /^\/@([a-zA-Z0-9._]{1,30})\/post\/([a-zA-Z0-9_-]+)\/?$/.exec(parsed.pathname);
    if (!match || match[1]?.toLowerCase() !== username.toLowerCase()) return null;
    return HOME_URL + "@" + username.toLowerCase() + "/post/" + match[2];
  } catch {
    return null;
  }
}
function requireExpectedIdentity(actual: BrowserIdentity, expected: BrowserIdentity): void {
  if (actual.id !== expected.id || actual.username.toLowerCase() !== expected.username.toLowerCase())
    throw new ProviderError("The live Threads session belongs to another profile. Reconnect the intended account.", { authExpired: true, sessionVerificationStatus: "mismatch" });
}

export class BrowserThreadsProvider {
  private readonly queues = new Map<string, Promise<{ externalPostId: string }>>();
  private readonly lastSent = new Map<string, number>();
  constructor(private readonly dependencies: PublishingDependencies) {}

  async publishPost(input: BrowserPublishInput): Promise<{ externalPostId: string }> {
    const previous = this.queues.get(input.accountId) ?? Promise.resolve();
    const publication = previous.catch(() => undefined).then(async () => {
      const lastSent = this.lastSent.get(input.accountId);
      if (lastSent !== undefined) {
        const remaining = lastSent + MIN_PUBLICATION_INTERVAL - this.dependencies.now();
        if (remaining > 0) await this.dependencies.pause(remaining);
      }
      const accessToken = input.loadSession ? await input.loadSession() : input.accessToken;
      return this.publishInWindow({ ...input, accessToken });
    });
    this.queues.set(input.accountId, publication);
    try {
      return await publication;
    } finally {
      if (this.queues.get(input.accountId) === publication) this.queues.delete(input.accountId);
    }
  }

  private async publishInWindow(input: BrowserPublishInput): Promise<{ externalPostId: string }> {
    if (!input.content.trim() || Array.from(input.content).length > POST_CHARACTER_LIMIT)
      throw new ProviderError("Use a nonempty Threads post of at most 500 characters.");
    if (!/^\d+$/.test(input.accountId) || !/^[a-zA-Z0-9._]{1,30}$/.test(input.username))
      throw new ProviderError("Reconnect this Threads account before publishing.", { authExpired: true });
    let state: BrowserStorageState;
    try {
      state = decodeBrowserSessionJSON(input.accessToken);
    } catch {
      throw new ProviderError("The saved Threads session cannot be restored. Reconnect this account.", { authExpired: true });
    }
    const cookies = authenticatedCookies(state, this.dependencies.now());
    if (!cookies || cookies.id !== input.accountId)
      throw new ProviderError("This Threads session has expired or belongs to another account. Reconnect it.", { authExpired: true });

    const expected: BrowserIdentity = { ...cookies, username: input.username };
    const preparationDeadline = this.dependencies.now() + 120_000;
    const requirePreparationTime = () => {
      if (this.dependencies.now() >= preparationDeadline)
        throw new ProviderError("Threads took too long to prepare this post. Nothing was submitted; publication can retry.", { retryable: true });
    };
    let window: PublishingWindow | undefined;
    let sendStarted = false;
    try {
      window = await this.dependencies.open(state, { userId: input.userId, username: input.username });
      requirePreparationTime();
      requireExpectedIdentity(await window.verifyIdentity(expected), expected);
      requirePreparationTime();
      const previous = new Set(
        (await window.readPosts(input.username, true))
          .map((post) => postURL(post.url, input.username))
          .filter((url): url is string => url !== null),
      );
      requirePreparationTime();
      await window.prepare(input.content, input.username);
      // Identity is checked again after opening the composer, before any send.
      requireExpectedIdentity(await window.verifyIdentity(expected), expected);
      requirePreparationTime();
      if (input.saveSession)
        await input.saveSession(JSON.stringify({ version: 1, storageState: await window.snapshot() }));
      requirePreparationTime();
      await input.markPublishStarted();
      const startedAt = this.dependencies.now();
      sendStarted = true;
      requireExpectedIdentity(await window.verifyIdentity(expected), expected);
      this.lastSent.set(input.accountId, startedAt);
      await window.send(input.content, input.username);

      // Threads can acknowledge the composer before the new post is visible
      // on the profile. Wait once for that propagation to settle, then navigate
      // to the profile and read its fresh DOM. Later attempts reuse that DOM.
      await this.dependencies.pause(CONFIRMATION_PROPAGATION_DELAY_MS);

      for (let attempt = 0; attempt < 12 && this.dependencies.now() < startedAt + 60_000; attempt++) {
        // Navigate to the profile once after sending. Subsequent checks only read
        // the current DOM so Threads does not receive a stream of reloads.
        const observed = await window.readPosts(input.username, attempt === 0);
        const confirmed = observed.filter((post) => {
          const url = postURL(post.url, input.username);
          const timestamp = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN;
          return url !== null && !previous.has(url) &&
            post.author.toLowerCase() === input.username.toLowerCase() &&
            normalizeText(post.text) === normalizeText(input.content) &&
            Number.isFinite(timestamp) &&
            timestamp >= startedAt - 5000 && timestamp <= this.dependencies.now() + 5000;
        });
        const urls = new Set(confirmed.map((post) => postURL(post.url, input.username)));
        if (urls.size === 1) {
          const [externalPostId] = urls;
          if (externalPostId) {
            requireExpectedIdentity(await window.verifyIdentity(expected), expected);
            return { externalPostId };
          }
        }
        if (urls.size > 1) throw new ProviderError(UNCERTAIN_MESSAGE, { uncertain: true });
        if (attempt < 11) await this.dependencies.pause(1500);
      }
      throw new ProviderError(UNCERTAIN_MESSAGE, { uncertain: true });
    } catch (error) {
      if (sendStarted) throw new ProviderError(UNCERTAIN_MESSAGE, { uncertain: true });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Threads could not prepare this post. Nothing was submitted; publication can retry.", { retryable: true });
    } finally {
      // A browser-close failure must not erase evidence of a confirmed publication.
      await window?.close().catch(() => undefined);
    }
  }
}

async function verifyContext(context: BrowserContext, expected: BrowserIdentity): Promise<BrowserIdentity> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const inspection = await inspectBrowserContext(context, expected);
    if (inspection.status === "verified") return inspection.identity;
    if (inspection.status === "expired" || inspection.status === "challenge" || inspection.status === "mismatch" || inspection.status === "blocked")
      throw new ProviderError(inspection.errorMessage, { authExpired: true, sessionVerificationStatus: inspection.status });
    if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ProviderError("Threads has not finished loading your signed-in profile. Publication can retry.", { retryable: true });
}

async function readProfilePosts(page: Page, username: string, navigate = true): Promise<BrowserPostObservation[]> {
  if (navigate)
    await page.goto(HOME_URL + "@" + encodeURIComponent(username), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator('a[href="/@' + username + '"],a[href="/@' + username + '/"],a[href*="/post/"]').filter({ visible: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  // The profile shell can become visible before Threads hydrates its post cards.
  // Wait for a real post anchor when one exists, then give its text a short
  // render window. This avoids reading the shell-only DOM as an empty profile.
  await page.locator('a[href*="/post/"]').filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  return page.evaluate(collectProfilePosts);
}

// This function runs in the page, without access to module helpers or transpiler bindings.
export function collectProfilePosts(): BrowserPostObservation[] {
  const observations: BrowserPostObservation[] = [];
  const semanticCardSelector = '[data-pressable-container],[role="article"],article';
  const profilePath = /^\/@[a-zA-Z0-9._]{1,30}\/?$/;
  const currentUrl = typeof location !== "undefined" ? location.href : "https://www.threads.com/";
  const baseUrl = currentUrl.startsWith("http") ? currentUrl : "https://www.threads.com/";
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')) {
    if (!anchor.getClientRects().length) continue;
    let card: HTMLElement | null = null;
    let candidate: HTMLElement | null = anchor.closest<HTMLElement>(semanticCardSelector) ?? anchor.parentElement;
    while (candidate) {
      const current = candidate;
      const postLinks = [...current.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')]
        .filter((link) => {
          if (!link.getClientRects().length) return false;
          const owner = link.closest(semanticCardSelector);
          return owner ? owner === current : current.contains(link);
        });
      const profileLinks = [...current.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter((link) => {
          if (!link.getClientRects().length || !profilePath.test(new URL(link.href, baseUrl).pathname)) return false;
          const owner = link.closest(semanticCardSelector);
          return owner ? owner === current : current.contains(link);
        });
      const lines = current.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (postLinks.length === 1 && profileLinks.length > 0
        && (current.matches(semanticCardSelector) || lines.length > 2)
        && current.getClientRects().length) {
        card = current;
        break;
      }
      candidate = current.parentElement;
    }
    if (!card || !card.getClientRects().length) continue;
    const authorLink = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).find((link) => {
      const url = new URL(link.href, baseUrl);
      if (link.getClientRects().length <= 0 || !profilePath.test(url.pathname) || link === anchor) return false;
      const owner = link.closest(semanticCardSelector);
      return owner ? owner === card : card.contains(link);
    });
    if (!authorLink) continue;
    const author = /^\/@([^/]+)\/?$/.exec(new URL(authorLink.href, baseUrl).pathname)?.[1];
    if (!author) continue;
    // Threads renders both an avatar link and a separate author-name link.
    // Exclude author links in the header, but retain mentions in the body.
    const cardLinks = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const timestampIndex = cardLinks.indexOf(anchor);
    const headerLinks = new Set(cardLinks.filter((link, index) => {
      const path = new URL(link.href, baseUrl).pathname;
      return path.replace(/\/$/, "").toLowerCase() === "/@" + author.toLowerCase()
        && index < timestampIndex;
    }));
    const pending: Node[] = [card];
    const parts: string[] = [];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.nodeType === 3) {
        parts.push(node.textContent ?? "");
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as HTMLElement;
      if (element !== card && element.matches(semanticCardSelector)) continue;
      if (element.matches('button,[role="button"],time,svg') || headerLinks.has(element as HTMLAnchorElement)) continue;
      if (element.tagName === "BR") {
        parts.push("\n");
        continue;
      }
      const children = Array.from(element.childNodes);
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child) pending.push(child);
      }
    }
    const text = parts.join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    observations.push({
      url: new URL(anchor.href, baseUrl).href,
      author,
      text,
      publishedAt: anchor.querySelector("time")?.getAttribute("datetime") ?? null,
    });
  }
  return observations;
}

async function oneVisible(locator: Locator, message: string): Promise<Locator> {
  const visible = locator.filter({ visible: true });
  if (await visible.count() !== 1) throw new ProviderError(message);
  return visible;
}

async function prepareComposer(page: Page, content: string, username: string): Promise<Locator> {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const newThread = page.getByRole("button", { name: /^new thread$/i });
  const create = page.getByLabel("Create", { exact: true });
  const placeholder = page.getByText("What's new?", { exact: true });
  const openers = [newThread, create, placeholder];
  await newThread.or(create).or(placeholder).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  let openButton: Locator | undefined;
  for (const opener of openers) {
    if (await opener.filter({ visible: true }).count()) {
      openButton = await oneVisible(opener, "Threads did not expose a unique new-post composer. Open Threads and check the account.");
      break;
    }
  }
  if (!openButton) throw new ProviderError("Threads did not expose a new-post composer.");
  await openButton.click({ timeout: 10_000 });
  const dialog = await ownComposer(page, username);
  if (await dialog.getByText(/^reply(?:ing)?(?: to)?\b/i).count())
    throw new ProviderError("Threads opened a reply composer instead of a new post. Nothing was submitted.");
  await requireComposerAuthor(dialog, username);
  const editor = await oneVisible(dialog.locator('[contenteditable="true"]'), "Threads exposed multiple editor fields. Only a single text post is supported.");
  if ((await editor.innerText()).trim())
    throw new ProviderError("The Threads composer already contains text. Nothing was submitted.");
  await editor.focus();
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) await editor.press("Shift+Enter");
    await editor.pressSequentially(lines[index]!, { delay: 40, timeout: 30_000 });
  }
  if (normalizeText(await editor.innerText()) !== normalizeText(content))
    throw new ProviderError("Threads did not preserve the full post text. Nothing was submitted.");
  const postButton = await oneVisible(dialog.getByRole("button", { name: /^post$/i }), "Threads did not expose a unique Post button.");
  await postButton.click({ trial: true, timeout: 10_000 });
  return postButton;
}

async function ownComposer(page: Page, username: string): Promise<Locator> {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const authorText = page.getByText(new RegExp("^@?" + escaped + "$", "i"))
    .and(page.locator(':not([contenteditable="true"]):not([contenteditable="true"] *)'));
  const authorLink = page.locator('a[href$="/@' + username + '"],a[href$="/@' + username + '/"]')
    .and(page.locator(':not([contenteditable="true"] *)'));
  const dialogs = page.getByRole("dialog")
    .filter({ has: page.locator('[contenteditable="true"]') })
    .filter({ has: authorText.or(authorLink).filter({ visible: true }) });
  await dialogs.first().waitFor({ state: "visible", timeout: 10_000 });
  return oneVisible(dialogs, "Threads did not expose a unique composer for the intended account.");
}

async function requireComposerAuthor(dialog: Locator, username: string): Promise<void> {
  const profile = dialog.locator('a[href*="/@"]:not([contenteditable="true"] *)').filter({ visible: true });
  const authors = await profile.evaluateAll((elements) => elements.map((element) => {
    const href = element.getAttribute("href");
    return href ? /^\/@([^/]+)\/?$/.exec(new URL(href, location.href).pathname)?.[1]?.toLowerCase() : undefined;
  }).filter(Boolean));
  if (authors.length > 0 && !authors.every((author) => author === username.toLowerCase()))
    throw new ProviderError("The composer belongs to a different profile. Reconnect the intended account.", { authExpired: true, sessionVerificationStatus: "mismatch" });
}

async function openPublishingWindow(state: BrowserStorageState, owner?: ProxyOwner): Promise<PublishingWindow> {
  const { browser, context, page } = await openProxyContext(owner, false, state).catch((error: unknown) => {
    throw new ProviderError(error instanceof HttpError ? error.userMessage : "Proxy verification failed. Threads was not opened.");
  });
  try {
    let postButton: Locator | undefined;
    return {
      verifyIdentity: (expected) => verifyContext(context, expected),
      readPosts: (username, navigate = true) => readProfilePosts(page, username, navigate),
      prepare: async (content, username) => { postButton = await prepareComposer(page, content, username); },
      send: async (content, username) => {
        if (!postButton) throw new ProviderError("The new-post composer is not ready.");
        const dialog = await ownComposer(page, username);
        await requireComposerAuthor(dialog, username);
        const editor = await oneVisible(dialog.locator('[contenteditable="true"]'), "Threads no longer exposes a single post editor.");
        if (normalizeText(await editor.innerText()) !== normalizeText(content))
          throw new ProviderError("The prepared Threads post changed before submission.");
        postButton = await oneVisible(dialog.getByRole("button", { name: /^post$/i }), "Threads did not expose the intended Post button.");
        await postButton.click({ timeout: 10_000 });
        // Let the site's submission finish before navigating away to check proof.
        await page.getByRole("dialog").filter({ has: page.locator('[contenteditable="true"]') })
          .waitFor({ state: "hidden", timeout: 15_000 }).catch((error: unknown) => {
            // A lingering composer is not evidence of failure. Continue to
            // inspect the profile; never click Post a second time.
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          });
      },
      snapshot: async () => filterSessionStorage(await context.storageState({ indexedDB: true })),
      close: () => browser.close(),
    };
  } catch {
    await browser.close().catch(() => undefined);
    throw new ProviderError("Threads could not open the saved session. Publication can retry.", { retryable: true });
  }
}

export const browserProvider = new BrowserThreadsProvider({
  open: openPublishingWindow,
  now: Date.now,
  pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});
