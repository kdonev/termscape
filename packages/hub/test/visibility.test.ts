import { describe, expect, it } from 'vitest';
import { canSee } from '../src/agents/visibility.js';

/*
 * The whole rule, as a matrix. A family on two machines' worth of addresses:
 * two roots the human started, a child of the first, two siblings under it,
 * and a grandchild under one of those.
 */
const rootA = { address: 'canvasws/root-a', parentAddress: null };
const rootB = { address: 'remotews/root-b', parentAddress: null };
const child = { address: 'remotews/child', parentAddress: rootA.address };
const sibling = { address: 'canvasws/sibling', parentAddress: rootA.address };
const grandchild = { address: 'canvasws/grandchild', parentAddress: child.address };

describe('canSee', () => {
  it('lets roots see each other, on any machine and in any workspace', () => {
    expect(canSee(rootA, rootB)).toBe(true);
    expect(canSee(rootB, rootA)).toBe(true);
  });

  it('treats an absent parent as a root, the same as null', () => {
    expect(canSee({ address: 'old/row' }, rootA)).toBe(true);
  });

  it('lets a parent and its child see each other', () => {
    expect(canSee(rootA, child)).toBe(true);
    expect(canSee(child, rootA)).toBe(true);
  });

  it('hides siblings from each other', () => {
    expect(canSee(child, sibling)).toBe(false);
    expect(canSee(sibling, child)).toBe(false);
  });

  it('hides a grandchild from its grandparent, both ways', () => {
    expect(canSee(rootA, grandchild)).toBe(false);
    expect(canSee(grandchild, rootA)).toBe(false);
    // Its own parent still sees it.
    expect(canSee(child, grandchild)).toBe(true);
  });

  it('hides a child from a root that did not spawn it, both ways', () => {
    expect(canSee(rootB, child)).toBe(false);
    expect(canSee(child, rootB)).toBe(false);
  });
});
