// how you appear to the other people in a session: the name over your cursor, and its color, which
// is the one that name already carries on the comments you write
import { userData } from '$lib/storage/userData';
import { colorFor } from '$lib/components/initialColor';
import { guestColor } from './guestColors';

export type PresenceRole = 'host' | 'guest';

export function presenceIdentity(role: PresenceRole, clientId = 0, name = userData.current.collabName): { name: string; color: string } {
	const typed = name.trim();
	return {
		name: typed || (role === 'host' ? 'Host' : 'Guest'),
		// an unnamed peer has nothing to derive from, and two of them still have to be told apart
		color: typed ? colorFor(typed) : guestColor(clientId)
	};
}
