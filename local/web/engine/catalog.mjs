// Project-igloo adoption catalog, shared by the host engine and the browser.
// It mirrors local/project_adoption.py (CATALOG) and the pinned server prices
// in houdini.sql: ten ordinary colors at 400 coins, the Blue Dog (1006) and the
// Orange Cat (1007) at 800. Rainbow (10) and Gold (11) have special upstream
// adoption rules and are not offered for project igloos.
export const MAX_PUFFLES_PER_IGLOO = 10;

const COLORS = ['blue', 'pink', 'black', 'green', 'purple', 'red', 'yellow', 'white', 'orange', 'brown'];

export const ADOPTION_CATALOG = Object.freeze([
  ...COLORS.map((color, typeId) => Object.freeze({ typeId, subtypeId: 0, puffleType: typeId, color, label: `${color[0].toUpperCase()}${color.slice(1)} puffle`, price: 400 })),
  Object.freeze({ typeId: 0, subtypeId: 1006, puffleType: 1006, color: 'blue-dog', label: 'Blue Dog puffle', price: 800 }),
  Object.freeze({ typeId: 8, subtypeId: 1007, puffleType: 1007, color: 'orange-cat', label: 'Orange Cat puffle', price: 800 }),
]);

export function catalogEntry(typeId, subtypeId) {
  return ADOPTION_CATALOG.find(item => item.typeId === typeId && item.subtypeId === subtypeId) ?? null;
}

export function catalogForPuffleType(puffleType) {
  return ADOPTION_CATALOG.find(item => item.puffleType === puffleType) ?? null;
}
