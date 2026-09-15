import { it, expect } from 'vitest';
import { GuestCommentOutbox } from '$lib/collab/guestCommentOutbox';
import { replyEvent } from '$lib/comments/log';

it('holds an event until the host echoes it, and hands back the rest to send again', () => {
	const outbox = new GuestCommentOutbox();
	const first = replyEvent({ id: 'm1', thread: 't1', by: 'mei', body: 'first', at: 'now' });
	const second = replyEvent({ id: 'm2', thread: 't1', by: 'mei', body: 'second', at: 'now' });
	outbox.sent(first);
	outbox.sent(second);
	outbox.echoed(JSON.parse(JSON.stringify(first)));
	expect(outbox.unanswered()).toEqual([second]);
	outbox.clear();
	expect(outbox.unanswered()).toEqual([]);
});
