/*
 * Real data captured from Priceline on 2026-09-21 for the Express Deal
 *   /relax/at/express/3000001393/... from 20260922 to 20260923
 * whose three guaranteed hotels were Red Roof PLUS+ Phoenix West (4593905),
 * Comfort Inn I-10 West at 51st Ave (48184) and Baymont by Wyndham
 * Phoenix I-10 near 51st Ave (2232505).
 *
 * The deal amenities were read from the rendered panel (DOM); the candidate
 * amenities came from the Apollo cache. That asymmetry is deliberate -- it is
 * the awkward real-world case the scorer has to survive, because the cache
 * omitted the Sanitation Procedures category that the DOM panel showed.
 *
 * NOTE: the Comfort Inn and Baymont amenity lists are partial. The live
 * capture was truncated at ~41 of 49 and ~42 of 57 items respectively. Both
 * still contain the decisive entries, and a partial decoy list understates the
 * gap, so it makes the test harder rather than easier.
 */

const DEAL_ROOM = [
  "Coffee/tea maker",
  "Ironing amenities",
  "Fire extinguishers",
  "Trash cans",
  "Room towels provided",
  "Telephone",
  "Bathtub",
  "Linens",
  "Safety deposit box",
  "Complimentary drinking water",
  "Sleep comfort items",
  "Blackout curtains",
  "Toiletries provided",
  "Alarm clock",
  "Separate shower/bathtub",
  "Cleaning products available",
  "Smoke alarms",
  "Carbon monoxide detector",
  "Air conditioning",
  "Shower",
  "Clothes drying rack",
  "Hair dryer",
  "Heating",
  "Socket near the bed",
  "Microwave",
  "Family rooms",
];

const DEAL_SECURITY = [
  "CCTV security in common areas",
  "Safety chain and/or latch on doors available",
];

const DEAL_SERVICES = [
  "Designated smoking area",
  "Cashless payment available",
  "Wake up call",
  "Desk/workspace available",
  "ATM or cash withdraw on site",
];

// Present on the deal panel but absent from the candidate Apollo caches.
const DEAL_SANITATION = [
  "Staff trained in safety protocol",
  "Physical/social distancing guidelines",
  "Contactless check-in/out",
  "Daily disinfection",
];

const DEAL_LANGUAGES = ["Spanish", "English"];

const DEAL_GENERAL = [
  "Heating in public area",
  "Air conditioning in public area",
  "Elevator",
  "Non-smoking rooms available",
  "24-hour front desk",
  "Pets allowed (charges may apply)",
  "Non-smoking property",
];

const DEAL_REST = [
  "TV & Movies/Shows",
  "Free Wi-Fi",
  "Vending machine",
  "On-site parking",
  "Free parking",
  "Outdoor pool",
  "Closed-caption TV",
  "Wheelchair accessible",
  "Facilities for disabled guests available",
  "Visual aids Braille/Tactile signs",
];

export const deal = {
  kind: "deal",
  url:
    "https://www.priceline.com/relax/at/express/3000001393/TOKEN/from/20260922/to/20260923/rooms/1",
  id: "3000001393",
  stars: "2.5",
  reviews: {
    count: 1200,
    countBucketed: true,
    overall: 6,
    overallLabel: "Pleasant",
    bucketed: true,
    sub: { Cleanliness: 7, Staff: 7, Location: 6 },
  },
  badges: ["Top Booked", "Family Friendly"],
  area: "West Phoenix - Avondale",
  amenitySource: "dom",
  amenities: [
    ...DEAL_ROOM,
    ...DEAL_SECURITY,
    ...DEAL_SERVICES,
    ...DEAL_SANITATION,
    ...DEAL_LANGUAGES,
    ...DEAL_GENERAL,
    ...DEAL_REST,
  ],
  candidates: [
    { hotelId: "2232505", name: "Baymont by Wyndham Phoenix I-10 near 51st Ave" },
    { hotelId: "4593905", name: "Red Roof PLUS+ Phoenix West" },
    { hotelId: "48184", name: "Comfort Inn I-10 West at 51st Ave Phoenix" },
  ],
};

// 52 amenities: exactly the deal list minus the Sanitation category, which is
// what the live cache returned.
const redRoofAmenities = [
  ...DEAL_ROOM,
  ...DEAL_SECURITY,
  ...DEAL_SERVICES,
  ...DEAL_LANGUAGES,
  ...DEAL_GENERAL,
  ...DEAL_REST,
];

export const candidates = [
  {
    hotelId: "2232505",
    name: "Baymont by Wyndham Phoenix I-10 near 51st Ave",
    fingerprint: {
      kind: "hotel",
      name: "Baymont by Wyndham Phoenix I-10 near 51st Ave",
      stars: "2.5",
      reviews: {
        count: 912,
        countBucketed: false,
        overall: 7.6,
        overallLabel: "Good",
        bucketed: false,
        sub: { Cleanliness: 7.9, Staff: 8.4, Location: 7.5 },
      },
      badges: [],
      area: "West Phoenix - Avondale",
      address: "Phoenix, AZ",
      amenitySource: "cache",
      amenities: [
        "24-hour front desk",
        "ATM or cash withdraw on site",
        "Accessible by stairs",
        "Accessible vanities available",
        "Air conditioning",
        "Air conditioning in public area",
        "Alarm clock",
        "Bathtub",
        "Blackout curtains",
        "CCTV security in common areas",
        "Cashless payment available",
        "Cleaning products available",
        "Clothes drying rack",
        "Coffee/tea maker",
        "Designated smoking area",
        "Desk/workspace available",
        "Elevator",
        "English",
        "Express check-in/check-out",
        "Facilities for disabled guests available",
        "Fire extinguishers",
        "First aid kit available",
        "Food delivery",
        "Free Breakfast",
        "Free Wi-Fi",
        "Free parking",
        "Hair dryer",
        "Heating in public area",
        "Indoor pool",
        "Invoices",
        "Ironing amenities",
        "Kitchenware",
        "Laundry services",
        "Linens",
        "Microwave",
        "Non-smoking property",
        "Non-smoking rooms available",
        "On-site parking",
        "Outdoor pool",
        "Refrigerator",
        "Room towels provided",
        "Safety chain and/or latch on doors available",
      ],
    },
  },
  {
    hotelId: "4593905",
    name: "Red Roof PLUS+ Phoenix West",
    fingerprint: {
      kind: "hotel",
      name: "Red Roof PLUS+ Phoenix West",
      stars: "2.5",
      reviews: {
        count: 1251,
        countBucketed: false,
        overall: 6.6,
        overallLabel: "Pleasant",
        bucketed: false,
        sub: { Cleanliness: 7.2, Staff: 7.5, Location: 6.8 },
      },
      badges: ["Top Booked", "Family Friendly"],
      area: "West Phoenix - Avondale",
      address: "5215 West Willetta Street, Phoenix, AZ",
      amenitySource: "cache",
      amenities: redRoofAmenities,
    },
  },
  {
    hotelId: "48184",
    name: "Comfort Inn I-10 West at 51st Ave Phoenix",
    fingerprint: {
      kind: "hotel",
      name: "Comfort Inn I-10 West at 51st Ave Phoenix",
      stars: "2.5",
      reviews: {
        count: 283,
        countBucketed: false,
        overall: 6.8,
        overallLabel: "Pleasant",
        bucketed: false,
        sub: { Cleanliness: 6.9, Staff: 7.8, Location: 7.1 },
      },
      badges: [],
      area: "West Phoenix - Avondale",
      address: "Phoenix, AZ",
      amenitySource: "cache",
      amenities: [
        "24-hour front desk",
        "Air conditioning",
        "Air conditioning in public area",
        "Bar",
        "Blackout curtains",
        "Cashless payment available",
        "Cleaning products available",
        "Coffee/tea maker",
        "Daily housekeeping",
        "Desk/workspace available",
        "English",
        "Facilities for disabled guests available",
        "Family rooms",
        "First aid kit available",
        "Fitness center",
        "Free Breakfast",
        "Free Wi-Fi",
        "Free parking",
        "Golf course",
        "Hair dryer",
        "Horseback riding",
        "Hot tub/Whirlpool",
        "Individually-wrapped food options",
        "Ironing amenities",
        "Kids' pool",
        "Laundry services",
        "Library",
        "Linens",
        "Meeting/banquet facilities",
        "Microwave",
        "Non-smoking property",
        "Non-smoking rooms available",
        "Off-site parking",
        "On-site parking",
        "Outdoor pool",
        "Pets allowed (charges may apply)",
        "Refrigerator",
        "Safety chain and/or latch on doors available",
        "Safety deposit box",
        "Shower",
        "Spa services",
      ],
    },
  },
];

export const expected = {
  winnerId: "4593905",
  dealAmenityCount: 56,
  redRoofAmenityCount: 52,
};
