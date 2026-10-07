// SQL for "Mozambique facilities (v1 layout)": v1's viewFacilities read from the CE warehouse copy of
// the facility register. build.mjs adds it to the custom-queries step of dist/pack.json.
//
// Column names and order follow v1. The register gives code, name, province and district. The
// facility register step keeps five more v1 values in extras (province_code, district_code,
// facility_type, hf_status, facility_national_code). The two Healthcare codes are built the way v1
// builds them, with '00' for a blank code. The columns v1 also leaves empty are NULL.
// DateTimeStamp is CE's update time, not v1's.
//
// Retired register rows are left out, so the result has the rows the current register lists.

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function facilitiesQuery(registerUrl) {
  const sql = `select
  updated_at                                 as "DateTimeStamp",          -- CE's time, not v1's
  '1.1.1'                                    as "VersionStamp",           -- fixed: v1 dictionary version
  facility_code                              as "FacilityCode",
  name                                       as "Description",
  (extras::json)->>'facility_type'           as "FacilityType",
  'MZ'                                       as "CountryCode",
  (extras::json)->>'province_code'           as "ProvinceCode",
  null                                       as "RegionCode",             -- empty in v1 too
  (extras::json)->>'district_code'           as "DistrictCode",
  null                                       as "SubDistrictCode",        -- empty in v1 too
  null                                       as "LattLong",               -- empty in v1 too
  ((extras::json)->>'hf_status')::int        as "HFStatus",
  null                                       as "HealthCareID",           -- empty in v1 too
  (extras::json)->>'facility_national_code'  as "FacilityNationalCode",
  'MZ'                                       as "HealthcareCountryCode",
  'MZ' || coalesce(nullif((extras::json)->>'province_code', ''), '00')
                                             as "HealthcareProvinceCode",
  'MZ' || coalesce(nullif((extras::json)->>'province_code', ''), '00') || '00'
       || coalesce(nullif((extras::json)->>'district_code', ''), '00')
                                             as "HealthcareDistrictCode",
  'Mozambique'                               as "CountryName",
  null                                       as "CountryLattLong",        -- empty in v1 too
  region                                     as "ProvinceName",
  null                                       as "ProvinceLattLong",       -- empty in v1 too
  district                                   as "DistrictName",
  null                                       as "DistrictLattLong"        -- empty in v1 too
from facility_registry
where facility_system = ${lit(registerUrl)}
  and register_state = 'in_register'
order by facility_code`;
  return { name: 'Mozambique facilities (v1 layout)', sql, params: [] };
}
