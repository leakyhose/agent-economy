// Every name a villager can have. Which villager gets which is shuffled by the seed.
export const NAMES = [
  'Kevinathan', 'Brandrew', 'Stevenjamin', 'Dougrick', 'Garyl', 'Tomothy', 'Bobathan', 'Chadrian',
  'Jennald', 'Marthew', 'Pauldrick', 'Timberly', 'Gregothy', 'Dennifer', 'Kurtney', 'Rondrew',
  'Danielbert', 'Kennethan', 'Jasonathan', 'Tammothy', 'Kyleb', 'Dustopher', 'Trevorian', 'Bradison',
  'Derekiah', 'Blakeob', 'Loganthony', 'Ethaniel', 'Samantheo', 'Liamuel', 'Masonathan', 'Oliviam',
  'Emmabeth', 'Harperson', 'Mialexa', 'Lukeas', 'Rubennett', 'Brucelyn', 'Floydrick', 'Earlexander',
  'Donnathan', 'Marvinnie', 'Wallacey', 'Budwin', 'Stanleyton', 'Gordonovan', 'Leroyston', 'Duanethan',
  'Gilbertrand', 'Howardo', 'Pamelvin', 'Debrandon', 'Rhondald', 'Glendavid', 'Normandra', 'Yolandrew',
  'Holliver', 'Kimbert', 'Heatherick', 'Dawnovan', 'Crystopher', 'Brookeith', 'Tracyrus', 'Staceyton',
  'Paigeorge', 'Morganthony', 'Heidirk', 'Carlvin', 'Philbur', 'Todderick', 'Keithaniel', 'Melvinda',
  'Rupertson', 'Lorrence', 'Nigeldon', 'Wendolyn', 'Bernathan', 'Normanuel', 'Frankenbert', 'Dwaynald',
  'Mortimothy', 'Archibaldwin', 'Svenjamin', 'Olafred', 'Maximilliam', 'Alejandrew', 'Francescott', 'Rafaelliot',
  'Klausten', 'Bjornathan', 'Gunthero', 'Ivanessa', 'Jonathaniel', 'Patrickson', 'Walterry', 'Methuselarry',
  'Elijames', 'Benedictor', 'Scottholomew', 'Mitchellangelo', 'Terrothy', 'Jefferick', 'Larrence', 'Barryl',
  'Jerrothy', 'Dannifer', 'Kennifer', 'Bennald', 'Sammothy', 'Craigory', 'Rickolas', 'Nickory',
  'Frankothy', 'Hankthony', 'Chuckard', 'Jackary', 'Zackson', 'Mattrick', 'Peterick', 'Jimbert',
  'Timbert', 'Bradrick', 'Brianthony', 'Ryanuel', 'Tylerick', 'Joshuel', 'Justinathan', 'Brettany',
  'Gavinald', 'Trentothy', 'Chandrew', 'Grantonio', 'Codyson', 'Travothy', 'Deanathan', 'Seanald',
  'Eriktor', 'Aaronald', 'Adamiel', 'Calebert', 'Susanthony', 'Jessicole', 'Megandrew', 'Kaitlynda',
  'Amandrew', 'Brittniel', 'Stephaniel', 'Nicoleman', 'Tiffaniel', 'Sarahnold', 'Lauranda', 'Emilander',
  'Hannald', 'Chelsamy', 'Karenthia', 'Melisson', 'Veronicole', 'Monicarl', 'Beckyle', 'Wendifer',
  'Barbaratha', 'Doristopher', 'Gladyson', 'Mildrick', 'Ethelvis', 'Bertrandy', 'Gertrudy', 'Herbertha',
  'Percivan', 'Cornelian', 'Winifredo', 'Reginathan', 'Horatiam', 'Ambrosely', 'Cuthbrian', 'Montgomerick',
  'Fitzgeraldo', 'Clarentino', 'Eugenathan', 'Archibob', 'Randrew', 'Kylexander', 'Dylanthony', 'Coltony',
  'Hunterick', 'Chaseton', 'Tannerly', 'Wyattley', 'Parkeith', 'Jaxony', 'Braydrew', 'Colbyson',
  'Eastonio', 'Rowanald', 'Jacerick', 'Declanny', 'Gideonald', 'Hudsonnie', 'Lincolnathan', 'Silastair',
];

// The list in seeded order. Its own generator, so drawing names never shifts the draws
// that traits and skills come from. Past the end of the list, names repeat with a number.
export function villagerNames(n, seed) {
  let s = (seed ^ 0x5bd1e995) & 0x7fffffff;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pool = [...NAMES];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return Array.from({ length: n }, (_, i) => i < pool.length ? pool[i] : `${pool[i % pool.length]} ${Math.floor(i / pool.length) + 1}`);
}
