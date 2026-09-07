# RouteSync — Islamabad Carpool & Ride-Sharing Platform

**RouteSync** is an intelligent carpooling and ride-matching platform built for university students and young professionals commuting across Islamabad and Rawalpindi. It enables commuters to discover overlapping travel corridors, share rides securely, split fares transparently, and reduce carbon emissions.

---

## 🚀 Key Features

### 1. Road-Network Corridor Matching
- **Live OSRM Routing:** Computes real road geometry, durations, and distances rather than simple Euclidean / straight-line approximations.
- **Corridor Overlap Scoring:** Identifies route overlaps (50%+ threshold) with a strict 15-minute maximum detour limit to protect commuters' schedules.
- **Visualized Route Legs:** Transparent breakdown of the route into lead pickup leg, shared corridor leg, and final drop-off leg.

### 2. Multi-Role Travel Modes
- **Looking for a Ride (Passenger):** Find drivers travelling on the same corridor and request a seat.
- **Offering a Ride (Driver):** Drivers declare vehicle type (Car or Bike), available seat capacity, and vehicle details to offer empty seats.
- **Split Ride-Hailing Cabs:** Coordinate and split fares evenly or proportionally for Yango, inDrive, or Careem trips.

### 3. Safety & Trust First
- **Gender-Based Matching:** Supports `female_only`, `male_only`, and `any` preferences. Enforces mutual safety rules for 1:1 and group rides.
- **Verified University/Institution Badges:** Instant verification for academic and corporate emails (e.g., `@nust.edu.pk`, `@fast.nu.edu.pk`, `@lums.edu.pk`).
- **Vehicle & CNIC Declarations:** Pakistani plate normalization and verification (e.g., `ISB-1234`, `LEA-20-1234`). Driver CNIC is validated securely, with only the masked last 4 digits ever exposed.
- **Emergency Safety Menu & SOS:** Quick access to emergency contacts, trip sharing links, and safety alerts.
- **In-App Messaging & Reviews:** Ephemeral match-specific chat and two-way commuter ratings.

### 4. Flexible Ride-Pooling & Group Consent
- **Dynamic Capacity Management:** Implements the *"most restrictive passenger wins"* rule for co-passenger limits.
- **Group Consent (3+ Riders):** When a newcomer requests to join an existing 2-person ride, the booking enters `pending_consent`, requiring approval from all existing riders before finalizing.
- **Carbon Impact Tracking:** Tracks cumulative CO₂ savings and fuel money saved per shared kilometer.

### 5. Natural Language Trip Input
- Powered by LLM parsing with heuristic fallbacks to extract origin, destination, departure time, and safety preferences directly from conversational text (e.g., *"Going from F-10 Markaz to NUST Gate 1 around 8:30 AM, female driver preferred"*).

---

## 🛠️ Architecture & Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Leaflet, Custom Design System
- **Backend:** Node.js, Express, TypeScript (`tsx`), Rate Limiting, CORS
- **Database & Auth:** Supabase (PostgreSQL), PostGIS spatial indexing, Row-Level Security (RLS), and database RPCs
- **Routing Engine:** Open Source Routing Machine (OSRM)
- **Geocoding:** Photon API biased to the Islamabad/Rawalpindi metropolitan grid

---

## 📁 Repository Structure

```
.
├── routemate-person-b/
│   ├── src/
│   │   ├── frontend/             # React UI components, cards, map, and forms
│   │   │   ├── App.tsx           # Main application view & state
│   │   │   ├── LocationSearchForm.tsx # Search & role toggle (Offer vs Look)
│   │   │   ├── MatchCard.tsx     # Commuter match card & leg breakdown
│   │   │   ├── MatchRouteMap.tsx # Interactive Leaflet corridor map
│   │   │   ├── SharedRideBrowser.tsx # Open pooled rides & group consent UI
│   │   │   └── tokens.css        # Design tokens & responsive styles
│   │   ├── apiHandler.ts         # Express REST API endpoints
│   │   ├── matchPipeline.ts      # Core matching pipeline & OSRM overlap
│   │   ├── poolingCapacity.ts    # Ride-pooling capacity & group consent logic
│   │   ├── fareSplit.ts          # Proportional fare calculations
│   │   ├── vehicleDeclaration.ts # Pakistani plate & CNIC validation
│   │   ├── verification.ts       # Educational domain allowlist verification
│   │   ├── nlpParser.ts          # Natural language trip parsing
│   │   ├── server.ts             # Express server entry point
│   │   └── test*.ts              # Comprehensive unit & integration test suites
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
└── supabase/
    ├── migrations/               # PostGIS, RLS policies, schemas & RPC functions
    ├── seed_day4.sql             # Test vectors & seed commuters
    ├── seed_day7.sql
    └── tests/                    # Database verification test suites
```

---

## ⚙️ Getting Started

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **npm** (v9 or higher)

### 2. Installation
Clone the repository and install dependencies:

```bash
git clone https://github.com/MairaJamal/RouteSync.git
cd RouteSync/routemate-person-b
npm install
```

### 3. Configure Environment
Copy `.env.example` to `.env` and fill in your Supabase and service keys:

```bash
cp .env.example .env
```

Key environment variables:
```ini
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3001

VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 4. Run the Development Environment

Start both the backend API and frontend Vite server concurrently:

```bash
npm run dev:all
```

- **Frontend:** [http://localhost:3000](http://localhost:3000)
- **Backend API:** [http://localhost:3001](http://localhost:3001)

To run services individually:
```bash
# Frontend only
npm run dev

# Backend API server only
npm run server
```

---

## 🧪 Testing

Run the automated test suites verifying all routing, pooling, safety, and fare logic:

```bash
npm test
```

This runs the comprehensive verification suites:
- ✅ Corridor Overlap & Detour Cap Tests
- ✅ Vehicle Matching & Ride-Hailing Fare Splits
- ✅ Pakistani Plate & CNIC Validation
- ✅ Group Safety & Multi-Passenger Pooling Rules
- ✅ Group Consent Expiry & Real-Time Notifications
- ✅ Academic Email Domain Allowlist Verification
- ✅ NLP Parser Heuristic Fallbacks

---

## 🛡️ License

This project is developed for commuter safety and sustainable mobility. Distributed under the ISC License.