export const ENCODINGS = [
    {
        "instructionId": "setffr_f",
        "encodingId": "setffr_f_",
        "mnemonic": "SETFFR",
        "className": "SVE",
        "fileName": "setffr_f.xml",
        "mask": 4294967295,
        "value": 623677440,
        "bitCount": 32,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
