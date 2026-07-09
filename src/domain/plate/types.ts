export type PlateExtractionStatus = "success" | "not_found" | "invalid_format" | "ambiguous";

export type PlateExtractionResult =
  | {
      status: "success";
      rawPlate: string;
      normalizedPlate: string;
      candidates: string[];
    }
  | {
      status: "not_found";
      candidates: string[];
      message: string;
    }
  | {
      status: "invalid_format";
      rawPlate: string;
      candidates: string[];
      message: string;
    }
  | {
      status: "ambiguous";
      candidates: string[];
      message: string;
    };
