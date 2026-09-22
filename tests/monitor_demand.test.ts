import { expect, test } from 'bun:test';
import { createMonitorDemand } from '../src/lib/utils/monitor_demand';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('coalesces mounts, counts duplicate views and drops subscriptions on disposal', async () => {
	const sends: string[][] = [];
	const demand = createMonitorDemand(
		async (ids) => {
			sends.push(ids);
		},
		(e) => {
			throw e;
		}
	);
	const first = demand.add('scope'),
		second = demand.add('scope'),
		meter = demand.add('meter');
	await settle();
	expect(sends).toEqual([['meter', 'scope']]);
	first();
	first();
	await settle();
	expect(sends).toHaveLength(1);
	second();
	meter();
	await settle();
	expect(sends.at(-1)).toEqual([]);
});

test('hiding sends an empty set without waiting for animation frames and restores only live views', async () => {
	const sends: string[][] = [];
	const demand = createMonitorDemand(
		async (ids) => {
			sends.push(ids);
		},
		(e) => {
			throw e;
		}
	);
	const release = demand.add('scope');
	await settle();
	demand.setVisible(false);
	await settle();
	expect(sends.at(-1)).toEqual([]);
	demand.add('other');
	release();
	await settle();
	expect(sends).toHaveLength(2);
	demand.setVisible(true);
	await settle();
	expect(sends.at(-1)).toEqual(['other']);
});

test('serializes slow IPC and sends the latest demand after an in-flight update', async () => {
	const sends: string[][] = [];
	let finish!: () => void;
	const demand = createMonitorDemand(
		async (ids) => {
			sends.push(ids);
			if (sends.length === 1)
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
		},
		(e) => {
			throw e;
		}
	);
	const release = demand.add('scope');
	await settle();
	demand.setVisible(false);
	release();
	demand.add('other');
	await settle();
	expect(sends).toHaveLength(1);
	finish();
	await settle();
	expect(sends).toEqual([['scope'], []]);
	demand.setVisible(true);
	await settle();
	expect(sends.at(-1)).toEqual(['other']);
});

test('a failed update can be retried after visibility changes', async () => {
	const errors: unknown[] = [],
		sends: string[][] = [];
	const demand = createMonitorDemand(
		async (ids) => {
			sends.push(ids);
			if (sends.length === 1) throw new Error('temporarily unavailable');
		},
		(error) => {
			errors.push(error);
		}
	);
	demand.add('scope');
	await settle();
	expect(errors).toHaveLength(1);
	demand.setVisible(true);
	await settle();
	expect(sends).toEqual([['scope'], ['scope']]);
});
