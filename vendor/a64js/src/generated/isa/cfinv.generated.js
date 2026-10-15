export const ENCODINGS = [
    {
        "instructionId": "CFINV",
        "encodingId": "CFINV_M_pstate",
        "mnemonic": "CFINV",
        "className": "System",
        "fileName": "cfinv.xml",
        "mask": 4294963455,
        "value": 3573563423,
        "bitCount": 28,
        "fields": [
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_FlagM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FlagM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
