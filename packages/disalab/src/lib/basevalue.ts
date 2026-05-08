export class BaseValue {
  ID: number;
  Value: string;
  Actual: string;

  constructor(id: number, value: string, actual: string) {
    this.ID = id;
    this.Value = value;
    this.Actual = actual;
  }
}
