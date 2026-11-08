import type { Flow } from '../wizard.ts';
import { addContentFlow } from './add-content.ts';
import { customizeFlows } from './customize.ts';

export const allFlows = (): Flow[] => [addContentFlow('MOVIE'), addContentFlow('SERIES'), addContentFlow('ANIME'), ...customizeFlows()];
