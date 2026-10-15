// Carga los helpers reales de documento de POS/js/core/utils.js para contextos vm aislados.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const c = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../../POS/js/core/utils.js', import.meta.url), 'utf8') + '\n;globalThis.__doc={isPlaceholderDoc,displayDoc,_naDocumentValue};', c);
export const docHelpers = c.__doc;
