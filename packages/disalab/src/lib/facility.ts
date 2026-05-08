import type { DisaServer } from "./types.js";

export class Facility {
  readonly #server: DisaServer | undefined;
  Code: string;
  FacilityName: string;
  Region: string;
  District: string;
  PostalAddress: string;
  Street: string;

  constructor(
    code: string,
    facilityname: string,
    address1: string,
    address2: string,
    address3: string,
    address4: string,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.Code = code;
    this.FacilityName = facilityname;
    this.Region = address4;
    this.District = address3;
    this.PostalAddress = address2;
    this.Street = address1;
  }
}
