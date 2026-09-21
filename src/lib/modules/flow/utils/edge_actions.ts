import type { Point } from './wiring';

export const EDGE_ACTIONS = 'splitwave:edge-actions';

export interface EdgeActions {
	editable: (id: string) => boolean;
	pending: (id: string) => boolean;
	add: (id: string, point: Point, source: Point, target: Point) => void;
	start: (id: string, index: number, event: PointerEvent) => void;
	menu: (id: string, event: MouseEvent, source: Point, target: Point, index?: number) => void;
}
