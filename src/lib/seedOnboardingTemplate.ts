import { collection, getDocs, query, orderBy, writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import type { OnboardingTemplateItem, Profile } from '../types';

/**
 * The starting checklist, transcribed from the "Acquisitions" tab of the
 * Standifer Capital Acquisition Checklist sheet. It only seeds an EMPTY
 * template collection — once a superadmin edits the template, this file is
 * never consulted again.
 *
 * Tuple: [section, code, indent, title, responsibility, daysFromClosing].
 * `responsibility` is the first name as written in the sheet; it's matched
 * against the profile directory at seed time and dropped if nobody matches.
 * `daysFromClosing` is negative for "before closing", per the sheet.
 */
type SeedRow = [string, string, 0 | 1, string, string | null, number | null];

const LEGAL = 'Legal';
const CM = 'Construction Management';
const BANK = 'Banking';
const TECH = 'Technology';
const OPS = 'Operations';
const VENDOR = 'Vendor Setup';
const MKT = 'Marketing';
const HR = 'HR & Corporate Operations';
const CLOSING = 'Closing Day';

const SEED_ROWS: SeedRow[] = [
  [LEGAL, '100', 0, 'Execute PSA', null, null],
  [LEGAL, '101', 0, 'Assign PSA to Property Owner', null, -5],
  [LEGAL, '102', 0, 'Form Entities', null, null],
  [LEGAL, '103', 1, 'Manager LLC - Form in DE', null, null],
  [LEGAL, '104', 1, 'Apartments LLC - Form in DE', null, null],
  [LEGAL, '105', 1, 'Apartments LLC - Register in state', null, null],
  [LEGAL, '106', 0, 'Execute PMA', null, -5],
  [LEGAL, '107', 0, 'Execute Accounting Fee Agreement', null, -5],
  [LEGAL, '108', 0, "Add Spark PM LLC to Property's Insurance as Additional Insured", null, -5],
  [LEGAL, '109', 0, 'Submit Housing Authority Transfer Docs', null, null],

  [CM, '200', 0, 'Create Interior Scope', null, 15],
  [CM, '201', 0, 'Finalize contractors for any Immediate repairs', null, 15],
  [CM, '202', 0, 'Add property to Standifer Capital CapEx Ordering Website', null, 0],

  [BANK, '300', 0, 'Set up Operating Account and Sec Deposit Account at US Bank', 'Greg', -5],
  [BANK, '301', 0, 'Set up Owner Account at FirstBank', 'Mike', -5],
  [BANK, '302', 0, 'Setup property in Avid', 'Greg', -10],

  [TECH, '400', 0, 'Order check scanner', "Chloe'", -15],
  [TECH, '401', 0, 'Order computer', "Chloe'", -15],
  [TECH, '402', 0, 'Order desk phone', "Chloe'", -15],
  [TECH, '403', 0, 'Set up employee emails', "Chloe'", -15],
  [TECH, '404', 0, 'Setup Office Internet', 'Jason', -5],
  [TECH, '405', 0, 'Self Guided Tour', 'Jason', 15],

  [OPS, '500', 0, 'Set up ResMan Database', 'Jason', -3],
  [OPS, '501', 0, 'Get Twilio regulatory approval for ResMan text messaging', 'Jason', -15],
  [OPS, '502', 0, 'Input resident data into ResMan', 'Jason', -3],
  [OPS, '503', 0, 'Set up answering service/emergency line with HelloSpoke', 'Jason', -3],
  [OPS, '504', 0, 'Order and Set up Bluemoon', 'Jason', -15],
  [OPS, '505', 0, 'Set up National Apartment association/local apartment association', 'Jason', -15],
  [OPS, '506', 0, 'Set up office phone (port number or new number)', 'Jason', -15],
  [OPS, '507', 0, 'Cancel vendor contracts', 'Mike', -3],
  [OPS, '508', 0, 'Set up ePremium', 'Jason', -15],
  [OPS, '509', 0, 'Put in rent increase notices to go into effect at closing', 'Jason', -3],
  [OPS, '510', 0, 'Manage Outstanding Evictions', 'Jason', -3],
  [OPS, '511', 0, 'Compile Tenant contact list', 'Jason', -3],
  [OPS, '512', 0, 'Create Property operations budget', 'Michael', -3],
  [OPS, '513', 0, 'Make utility & water shutoffs map', null, null],
  [OPS, '514', 0, 'Bulk Internet', 'Michael', 0],
  [OPS, '515', 0, 'Create Property Information Sheet, Rent Survey, and Other Tech', 'Michael', 0],

  [VENDOR, '600', 0, 'Contract COR PM Solutions', 'Jason', -30],
  [VENDOR, '601', 0, 'Contract ResMan (including DIV, Resman Payments, Resman Screening)', 'Jason', -30],
  [VENDOR, '602', 0, 'Contract EliseAI', 'Jason', -30],
  [VENDOR, '603', 0, 'Contract Conservice', 'Jason', -30],
  [VENDOR, '604', 0, 'Contract Rent Debt Automated', 'Jason', 0],
  [VENDOR, '605', 0, 'Contract Digital Fire', "Chloe'", -30],
  [VENDOR, '606', 0, 'Amazon account setup', "Chloe'", -30],
  [VENDOR, '607', 0, 'HD Supply account setup', 'Jason', 3],
  [VENDOR, '608', 0, 'Lowes account setup', 'Jason', 3],
  [VENDOR, '609', 0, 'Sherwin Williams account setup', 'Jason', -30],
  [VENDOR, '610', 0, "Leslie's Pools (In the Swim) account setup", 'Jason', -30],
  [VENDOR, '611', 0, 'Contract Trash', 'Michael', -15],
  [VENDOR, '612', 0, 'Contract Pest', 'Michael', -15],
  [VENDOR, '613', 0, 'Contract Landscaping', 'Michael', -15],
  [VENDOR, '614', 0, 'Contract Fire/Life Safety', 'Michael', -15],
  [VENDOR, '615', 0, 'Set up Electric', 'Jason', -3],
  [VENDOR, '616', 0, 'Set up Water / Sewer', 'Jason', -3],
  [VENDOR, '617', 0, 'Set up Taggart', 'Jason', -30],
  [VENDOR, '618', 0, 'Set up PetScreening', 'Jason', -30],
  [VENDOR, '619', 0, 'Set up Epremium / Import existing policies', 'Jason', -30],

  [MKT, '700', 0, 'Get new photos', 'Edita', 30],
  [MKT, '701', 0, 'Set up Apartments.com / Zillow', 'Edita', 30],
  [MKT, '702', 0, 'Purchase Property Domain', "Chloe'", -30],
  [MKT, '703', 0, 'Set up Property Website Landing Page', 'Edita', -30],
  [MKT, '704', 0, 'Set up Full Property Website', 'Edita', 15],
  [MKT, '705', 0, 'Add to Standifer Website', 'Edita', 15],
  [MKT, '706', 0, 'Make Standifer LinkedIn Post', 'Edita', 15],
  [MKT, '707', 0, 'Add to Spark Management Website', 'Edita', 15],
  [MKT, '708', 0, 'Make property floorplans', 'Edita', 30],
  [MKT, '709', 0, 'Make property map', 'Edita', 30],
  [MKT, '710', 0, 'Make property brochure', 'Edita', 30],
  [MKT, '711', 0, 'Google My Business setup/transfer', 'Edita', 0],
  [MKT, '712', 0, 'Get Matterport tour of each floorplan', 'Edita', 30],
  [MKT, '713', 0, 'Take over Apple maps listing', 'Edita', 0],
  [MKT, '714', 0, 'Take over Meta profiles (Facebook and Instagram)', 'Edita', 0],
  [MKT, '715', 0, 'Send ILS recs', 'Edita', -30],
  [MKT, '716', 0, 'Confirm self-guided tour links', null, null],
  [MKT, '717', 0, 'Confirm tracking numbers and emails from ResMan to provide ILS reps', null, null],
  [MKT, '718', 0, 'Add property to Google Analytics and send the tracking code', null, null],

  [HR, '800', 0, 'Business Registration - County / City', 'Jason', -15],
  [HR, '801', 0, 'Interview Staff/Determine who to keep', "Chloe'", -30],
  [HR, '802', 0, 'Hire and Onboard Staff', "Chloe'", -15],
  [HR, '803', 0, 'Unemployment Employer Account Registration', "Chloe'", -15],
  [HR, '804', 0, 'Health Benefit Plans', "Chloe'", -15],
  [HR, '805', 0, 'Add to Workers Compensation Policy', "Chloe'", 0],
  [HR, '806', 0, 'Required Fed/State Labor Law Posters', "Chloe'", -15],
  [HR, '807', 0, 'Update Employee Handbook/Policies', "Chloe'", 0],
  [HR, '808', 0, 'Set-up Pre-Employment Lab Testing', "Chloe'", -15],
  [HR, '809', 0, 'Set up Location and Employees in Namely (HR/Payroll)', "Chloe'", -15],
  [HR, '810', 0, 'Business Cards', 'Edita', -15],
  [HR, '811', 0, 'Google Review NFC stand', 'Edita', 0],
  [HR, '812', 0, 'Add property to any email distribution lists', "Chloe'", 0],
  [HR, '813', 0, 'Fair Housing Poster', "Chloe'", 0],
  [HR, '814', 0, 'Set up Timeroo', "Chloe'", -15],
  [HR, '815', 0, 'On-site Staff T-shirts', "Chloe'", -15],
  [HR, '816', 0, 'On-site Staff Name Badges', "Chloe'", -15],

  [CLOSING, '900', 0, 'Notice to tenants about new ownership', 'Jason', 0],
  [CLOSING, '901', 0, 'Collect all keys, alarm codes, or combinations', 'Jason', 0],
  [CLOSING, '902', 0, 'Walk all vacant units', 'Jason', 0],
  [CLOSING, '903', 0, 'Change office locks', 'Jason', 0],
  [CLOSING, '904', 0, 'Set up computer', 'Jason', 0],
  [CLOSING, '905', 0, 'Request copy of Final Resident Ledgers', 'Jason', 0],
  [CLOSING, '906', 0, 'Send email to SW to unlock accounts', 'Jason', 0],
  [CLOSING, '907', 0, 'Request ownership for Google My Business', 'Jason', 0],
  [CLOSING, '908', 0, 'Send Termination to Charter Distribution Agreement', 'Jason', 0],
];

/**
 * Match a sheet responsibility ("Jason", "Chloe'") to a profile id by first
 * name, case- and punctuation-insensitively. Ambiguous or unknown names seed
 * as unassigned rather than guessing wrong.
 */
function resolveResponsible(name: string | null, profiles: Profile[]): string[] {
  if (!name) return [];
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const target = normalize(name);
  const matches = profiles.filter((p) => normalize(p.name.split(' ')[0] || '') === target);
  return matches.length === 1 ? [matches[0].id] : [];
}

/**
 * Read the template, seeding it from SEED_ROWS on first use. Mirrors
 * getOrSeedRequestTypes: seeding needs superadmin write access and fails
 * silently (returning an empty list) for everyone else.
 */
export async function getOrSeedOnboardingTemplate(profiles: Profile[]): Promise<OnboardingTemplateItem[]> {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, 'onboardingTemplate'), orderBy('order')));
  if (snap.size > 0) {
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OnboardingTemplateItem));
  }

  const items: OnboardingTemplateItem[] = SEED_ROWS.map((row, i) => ({
    id: doc(collection(db!, 'onboardingTemplate')).id,
    section: row[0],
    code: row[1],
    indent: row[2],
    title: row[3],
    responsibleIds: resolveResponsible(row[4], profiles),
    daysFromClosing: row[5],
    // Leave gaps so rows can be inserted between two neighbours without
    // renumbering the whole list.
    order: (i + 1) * 100,
  }));

  try {
    // Firestore caps a batch at 500 writes; the seed is ~140 but chunk anyway so
    // a grown seed list can't silently fail.
    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      for (const item of items.slice(i, i + 400)) {
        const { id, ...data } = item;
        batch.set(doc(db, 'onboardingTemplate', id), { ...data, createdAt: serverTimestamp() });
      }
      await batch.commit();
    }
  } catch (err) {
    console.warn('Could not seed the onboarding template (superadmin required):', err);
    return [];
  }
  return items;
}
