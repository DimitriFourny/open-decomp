export const ENCODINGS = [
    {
        "instructionId": "SB",
        "encodingId": "SB_only_barriers",
        "mnemonic": "SB",
        "className": "System",
        "fileName": "sb.xml",
        "mask": 4294963455,
        "value": 3573756159,
        "bitCount": 28,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SB"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SB",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "no-operands"
    }
];
