// a guest's comment events, kept until the host echoes each one back
import type { CommentEvent } from '$lib/comments/log';

const KEEP = 200;

export class GuestCommentOutbox {
	private waiting: { key: string; event: CommentEvent }[] = [];

	sent(event: CommentEvent): void {
		this.waiting.push({ key: JSON.stringify(event), event });
		if (this.waiting.length > KEEP) this.waiting.splice(0, this.waiting.length - KEEP);
	}

	echoed(event: CommentEvent): void {
		const key = JSON.stringify(event);
		const at = this.waiting.findIndex((w) => w.key === key);
		if (at >= 0) this.waiting.splice(at, 1);
	}

	unanswered(): CommentEvent[] {
		return this.waiting.map((w) => w.event);
	}

	clear(): void {
		this.waiting = [];
	}
}
