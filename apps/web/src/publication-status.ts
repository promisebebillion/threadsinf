import type { Post, PostStatus, PostTarget } from "@threadflow/shared";

export function targetNeedsConfirmation(target: PostTarget): boolean {
  return target.status === "unconfirmed" || target.publishUncertain;
}

export function postNeedsConfirmation(post: Post): boolean {
  return post.status === "unconfirmed" || post.targets.some(targetNeedsConfirmation);
}

export function displayPostStatus(post: Post): PostStatus {
  return postNeedsConfirmation(post) ? "unconfirmed" : post.status;
}

export function postStatusLabel(status: string): string {
  return status === "unconfirmed"
    ? "Needs confirmation"
    : status.charAt(0).toUpperCase() + status.slice(1);
}
