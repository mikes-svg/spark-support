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

const DD = 'Due Diligence';
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
  [DD, '100', 0, 'Inspections', null, null],
  [DD, '101', 1, 'Sewer Lines', null, null],
  [DD, '102', 1, 'Roof', null, null],
  [DD, '103', 1, 'Electrical', null, null],
  [DD, '104', 1, 'Plumbing', null, null],
  [DD, '105', 1, 'Pool (Equipment and Leak Detection Pressure Test)', null, null],
  [DD, '106', 1, 'Termites', null, null],
  [DD, '107', 1, 'Foundation', null, null],
  [DD, '108', 1, 'Sprinkler Inspection', null, null],
  [DD, '109', 0, 'Title', null, null],
  [DD, '110', 0, 'Third Party Reports', null, null],
  [DD, '111', 1, 'ALTA Survey', null, null],
  [DD, '112', 1, 'Flood Determination Report', null, null],
  [DD, '113', 1, 'Property Tax Opinion', null, null],
  [DD, '114', 1, 'ESA w/ Radon', null, null],
  [DD, '115', 1, 'PCA', null, null],
  [DD, '116', 1, 'Zoning Report', null, null],
  [DD, '117', 0, 'Insurance Quote', null, null],
  [DD, '118', 0, 'Check Property YOC on Property Tax Records', null, null],
  [DD, '119', 0, 'Service Contracts', null, null],
  [DD, '120', 1, 'Landscaping', null, null],
  [DD, '121', 1, 'Pest', null, null],
  [DD, '122', 1, 'Trash', null, null],
  [DD, '123', 1, 'Laundry', null, null],
  [DD, '124', 1, 'Fire Monitoring', null, null],
  [DD, '125', 0, 'Lease Audit', 'Jason', null],
  [DD, '126', 0, 'Utility Audit', 'Jason', null],
  [DD, '127', 0, 'Unit Walks', null, null],
  [DD, '128', 0, 'Debt Term Sheets', null, null],
  [DD, '129', 0, 'QC Estimate and Doc Review', null, null],

  [LEGAL, '200', 0, 'Execute PSA', null, null],
  [LEGAL, '201', 0, 'Assign PSA to Property Owner', null, -5],
  [LEGAL, '202', 0, 'Form Entities', null, null],
  [LEGAL, '203', 1, 'Manager LLC - Form in DE', null, null],
  [LEGAL, '204', 1, 'Apartments LLC - Form in DE', null, null],
  [LEGAL, '205', 1, 'Apartments LLC - Register in state', null, null],
  [LEGAL, '206', 0, 'Execute PMA', null, -5],
  [LEGAL, '207', 0, 'Execute Accounting Fee Agreement', null, -5],
  [LEGAL, '208', 0, "Add Spark PM LLC to Property's Insurance as Additional Insured", null, -5],
  [LEGAL, '209', 0, 'Submit Housing Authority Transfer Docs', null, null],

  [CM, '300', 0, 'Create Interior Scope', null, 15],
  [CM, '301', 0, 'Finalize contractors for any Immediate repairs', null, 15],
  [CM, '302', 0, 'Add property to Standifer Capital CapEx Ordering Website', null, 0],

  [BANK, '400', 0, 'Set up Operating Account and Sec Deposit Account at US Bank', 'Greg', -5],
  [BANK, '401', 0, 'Set up Owner Account at FirstBank', 'Mike', -5],
  [BANK, '402', 0, 'Setup property in Avid', 'Greg', -10],

  [TECH, '500', 0, 'Order check scanner', "Chloe'", -15],
  [TECH, '501', 0, 'Order computer', "Chloe'", -15],
  [TECH, '502', 0, 'Order desk phone', "Chloe'", -15],
  [TECH, '503', 0, 'Set up employee emails', "Chloe'", -15],
  [TECH, '504', 0, 'Setup Office Internet', 'Jason', -5],
  [TECH, '505', 0, 'Self Guided Tour', 'Jason', 15],

  [OPS, '600', 0, 'Set up ResMan Database', 'Jason', -3],
  [OPS, '601', 0, 'Get Twilio regulatory approval for ResMan text messaging', 'Jason', -15],
  [OPS, '602', 0, 'Input resident data into ResMan', 'Jason', -3],
  [OPS, '603', 0, 'Set up answering service/emergency line with HelloSpoke', 'Jason', -3],
  [OPS, '604', 0, 'Order and Set up Bluemoon', 'Jason', -15],
  [OPS, '605', 0, 'Set up National Apartment association/local apartment association', 'Jason', -15],
  [OPS, '606', 0, 'Set up office phone (port number or new number)', 'Jason', -15],
  [OPS, '607', 0, 'Cancel vendor contracts', 'Mike', -3],
  [OPS, '608', 0, 'Set up ePremium', 'Jason', -15],
  [OPS, '609', 0, 'Put in rent increase notices to go into effect at closing', 'Jason', -3],
  [OPS, '610', 0, 'Manage Outstanding Evictions', 'Jason', -3],
  [OPS, '611', 0, 'Compile Tenant contact list', 'Jason', -3],
  [OPS, '612', 0, 'Create Property operations budget', 'Michael', -3],
  [OPS, '613', 0, 'Make utility & water shutoffs map', null, null],
  [OPS, '614', 0, 'Bulk Internet', 'Michael', 0],
  [OPS, '615', 0, 'Create Property Information Sheet, Rent Survey, and Other Tech', 'Michael', 0],

  [VENDOR, '700', 0, 'Contract COR PM Solutions', 'Jason', -30],
  [VENDOR, '701', 0, 'Contract ResMan (including DIV, Resman Payments, Resman Screening)', 'Jason', -30],
  [VENDOR, '702', 0, 'Contract EliseAI', 'Jason', -30],
  [VENDOR, '703', 0, 'Contract Conservice', 'Jason', -30],
  [VENDOR, '704', 0, 'Contract Rent Debt Automated', 'Jason', 0],
  [VENDOR, '705', 0, 'Contract Digital Fire', "Chloe'", -30],
  [VENDOR, '706', 0, 'Amazon account setup', "Chloe'", -30],
  [VENDOR, '707', 0, 'HD Supply account setup', 'Jason', 3],
  [VENDOR, '708', 0, 'Lowes account setup', 'Jason', 3],
  [VENDOR, '709', 0, 'Sherwin Williams account setup', 'Jason', -30],
  [VENDOR, '710', 0, "Leslie's Pools (In the Swim) account setup", 'Jason', -30],
  [VENDOR, '711', 0, 'Contract Trash', 'Michael', -15],
  [VENDOR, '712', 0, 'Contract Pest', 'Michael', -15],
  [VENDOR, '713', 0, 'Contract Landscaping', 'Michael', -15],
  [VENDOR, '714', 0, 'Contract Fire/Life Safety', 'Michael', -15],
  [VENDOR, '715', 0, 'Set up Electric', 'Jason', -3],
  [VENDOR, '716', 0, 'Set up Water / Sewer', 'Jason', -3],
  [VENDOR, '717', 0, 'Set up Taggart', 'Jason', -30],
  [VENDOR, '718', 0, 'Set up PetScreening', 'Jason', -30],
  [VENDOR, '719', 0, 'Set up Epremium / Import existing policies', 'Jason', -30],

  [MKT, '800', 0, 'Get new photos', 'Edita', 30],
  [MKT, '801', 0, 'Set up Apartments.com / Zillow', 'Edita', 30],
  [MKT, '802', 0, 'Purchase Property Domain', "Chloe'", -30],
  [MKT, '803', 0, 'Set up Property Website Landing Page', 'Edita', -30],
  [MKT, '804', 0, 'Set up Full Property Website', 'Edita', 15],
  [MKT, '805', 0, 'Add to Standifer Website', 'Edita', 15],
  [MKT, '806', 0, 'Make Standifer LinkedIn Post', 'Edita', 15],
  [MKT, '807', 0, 'Add to Spark Management Website', 'Edita', 15],
  [MKT, '808', 0, 'Make property floorplans', 'Edita', 30],
  [MKT, '809', 0, 'Make property map', 'Edita', 30],
  [MKT, '810', 0, 'Make property brochure', 'Edita', 30],
  [MKT, '811', 0, 'Google My Business setup/transfer', 'Edita', 0],
  [MKT, '812', 0, 'Get Matterport tour of each floorplan', 'Edita', 30],
  [MKT, '813', 0, 'Take over Apple maps listing', 'Edita', 0],
  [MKT, '814', 0, 'Take over Meta profiles (Facebook and Instagram)', 'Edita', 0],
  [MKT, '815', 0, 'Send ILS recs', 'Edita', -30],
  [MKT, '816', 0, 'Confirm self-guided tour links', null, null],
  [MKT, '817', 0, 'Confirm tracking numbers and emails from ResMan to provide ILS reps', null, null],
  [MKT, '818', 0, 'Add property to Google Analytics and send the tracking code', null, null],

  [HR, '900', 0, 'Business Registration - County / City', 'Jason', -15],
  [HR, '901', 0, 'Interview Staff/Determine who to keep', "Chloe'", -30],
  [HR, '902', 0, 'Hire and Onboard Staff', "Chloe'", -15],
  [HR, '903', 0, 'Unemployment Employer Account Registration', "Chloe'", -15],
  [HR, '904', 0, 'Health Benefit Plans', "Chloe'", -15],
  [HR, '905', 0, 'Add to Workers Compensation Policy', "Chloe'", 0],
  [HR, '906', 0, 'Required Fed/State Labor Law Posters', "Chloe'", -15],
  [HR, '907', 0, 'Update Employee Handbook/Policies', "Chloe'", 0],
  [HR, '908', 0, 'Set-up Pre-Employment Lab Testing', "Chloe'", -15],
  [HR, '909', 0, 'Set up Location and Employees in Namely (HR/Payroll)', "Chloe'", -15],
  [HR, '910', 0, 'Business Cards', 'Edita', -15],
  [HR, '911', 0, 'Google Review NFC stand', 'Edita', 0],
  [HR, '912', 0, 'Add property to any email distribution lists', "Chloe'", 0],
  [HR, '913', 0, 'Fair Housing Poster', "Chloe'", 0],
  [HR, '914', 0, 'Set up Timeroo', "Chloe'", -15],
  [HR, '915', 0, 'On-site Staff T-shirts', "Chloe'", -15],
  [HR, '916', 0, 'On-site Staff Name Badges', "Chloe'", -15],

  [CLOSING, '1000', 0, 'Notice to tenants about new ownership', 'Jason', 0],
  [CLOSING, '1001', 0, 'Collect all keys, alarm codes, or combinations', 'Jason', 0],
  [CLOSING, '1002', 0, 'Walk all vacant units', 'Jason', 0],
  [CLOSING, '1003', 0, 'Change office locks', 'Jason', 0],
  [CLOSING, '1004', 0, 'Set up computer', 'Jason', 0],
  [CLOSING, '1005', 0, 'Request copy of Final Resident Ledgers', 'Jason', 0],
  [CLOSING, '1006', 0, 'Send email to SW to unlock accounts', 'Jason', 0],
  [CLOSING, '1007', 0, 'Request ownership for Google My Business', 'Jason', 0],
  [CLOSING, '1008', 0, 'Send Termination to Charter Distribution Agreement', 'Jason', 0],
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
