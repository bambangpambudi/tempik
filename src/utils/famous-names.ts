// src/utils/famous-names.ts
// Nama-nama tokoh Indonesia (Presiden, Wapres, Menteri, Pahlawan)

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHANUM[arr[i] % ALPHANUM.length];
  return out;
}

export const FAMOUS_NAMES: string[] = [
  // === Presiden RI ===
  'soekarno', 'soeharto', 'habibie', 'gusdur', 'megawati',
  'sby', 'susilobambang', 'jokowi', 'jokowidodo', 'prabowo',
  'prabowosubianto',

  // === Wakil Presiden RI ===
  'hatta', 'mohammadhatta', 'sultanhamengku', 'hamengkubuwono',
  'adammalik', 'umarwirahadikusumah', 'sudharmono', 'trysutrisno',
  'hamzahhaz', 'jusufkalla', 'juskalla', 'boediono',
  'marufamin', 'gibran', 'gibranrakabuming',

  // === Menteri Keuangan ===
  'srimulyani', 'chatibbasri', 'mariemuhammad', 'fuadbawazier',
  'bambangsudibyo', 'agusmartowardojo', 'brodjonegoro',

  // === Menteri Luar Negeri ===
  'retnomarsudi', 'martynatalegawa', 'marty', 'hassanwirajuda',
  'wiranata', 'alimusa',

  // === Menteri Kabinet ===
  'susipudjiastuti', 'nadiem', 'nadiemmakarim', 'erickthohir',
  'luhut', 'luhutpanjaitan', 'airlangga', 'muhaimin',
  'sandiyaga', 'sandiagauno', 'basuki', 'basukihadjimuljono',
  'tjahjo', 'budikarya', 'moeldoko', 'wiranto',
  'pratikno', 'pramonoanung', 'muhadjir', 'yasonna',
  'titokarnavian', 'idafauziyah', 'syahrul', 'budigunadi',
  'saktiwahyu', 'rismaharini', 'trismaharini',

  // === Gubernur Terkenal ===
  'aniesbaswedan', 'anies', 'ahok', 'basukitjahaja',
  'ridwankamil', 'kang-emil', 'ganjar', 'ganjarpranowo',
  'khofifah', 'herubudi',

  // === Gubernur Bank Indonesia ===
  'perrywarjiyo', 'darminnasution', 'burhanuddin',

  // === Pahlawan Nasional & Proklamator ===
  'tanmalaka', 'sjahrir', 'sutansjahrir', 'diponegoro',
  'sudirman', 'jendralsudirman', 'kartini', 'rahmat',
  'kihajardewantara', 'tjokroaminoto', 'wahidhasyim',
  'soebardjo', 'achmadsoebardjo',

  // === Tokoh Ekonomi & Politik ===
  'rizalramli', 'kwikkian', 'kwikkangie', 'ginandjar',
  'ginandjarkartasasmita',

  // === Politisi Senior ===
  'puanmahrani', 'akbartanjung', 'amienrais', 'abdurrahman',
];

export async function generateFamousAddress(
  checkExists: (addr: string) => Promise<boolean> | boolean,
  domain: string,
  maxAttempts: number = 20
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const name = FAMOUS_NAMES[Math.floor(Math.random() * FAMOUS_NAMES.length)];
    const suffix = randomString(6);
    const localPart = name + '_' + suffix;
    const address = localPart + '@' + domain;
    const exists = await checkExists(address);
    if (!exists) return address;
  }
  // Fallback jika 20x tabrakan (sangat jarang terjadi)
  const fallback = 'user_' + randomString(8);
  return fallback + '@' + domain;
}
