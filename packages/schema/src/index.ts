/**
 * The single source of ProseMirror schema truth.
 *
 * This module is imported, unchanged, by:
 *   - the client editor (apps/server/client/editor.ts)
 *   - the server applier (packages/core/src/applier.ts)
 *   - the replay viewer (apps/server/client/replay.ts)
 *
 * Per the build spec (§5, §12): the schema lives in exactly one place so that
 * the server reconstructs documents with the *same* schema and the *same*
 * prosemirror-transform library the client used to produce the steps.
 * Never duplicate or fork this schema.
 */
import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

/**
 * Basic block/inline document schema plus ordered/bullet lists.
 *
 * Nodes: doc, paragraph, blockquote, horizontal_rule, heading, code_block,
 *        text, image, hard_break, ordered_list, bullet_list, list_item.
 * Marks: link, em, strong, code.
 */
export const schema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
  marks: basicSchema.spec.marks,
});

export type { Schema } from 'prosemirror-model';
