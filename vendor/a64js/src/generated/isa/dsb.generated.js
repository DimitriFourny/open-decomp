export const ENCODINGS = [
    {
        "instructionId": "DSB",
        "encodingId": "DSB_BOn_barriers",
        "mnemonic": "DSB",
        "className": "Memory nXS barrier",
        "fileName": "dsb.xml",
        "mask": 4294964223,
        "value": 3573756479,
        "bitCount": 30,
        "fields": [
            {
                "name": "imm2",
                "lsb": 10,
                "width": 2
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
            "FEAT_XS"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_XS",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "barrier"
    },
    {
        "instructionId": "DSB",
        "encodingId": "DSB_BO_barriers",
        "mnemonic": "DSB",
        "className": "Memory barrier",
        "fileName": "dsb.xml",
        "mask": 4294963455,
        "value": 3573756063,
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
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "barrier"
    }
];
