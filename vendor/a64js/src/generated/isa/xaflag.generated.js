export const ENCODINGS = [
    {
        "instructionId": "XAFLAG",
        "encodingId": "XAFLAG_M_pstate",
        "mnemonic": "XAFLAG",
        "className": "System",
        "fileName": "xaflag.xml",
        "mask": 4294963455,
        "value": 3573563455,
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
            "FEAT_FlagM2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FlagM2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
