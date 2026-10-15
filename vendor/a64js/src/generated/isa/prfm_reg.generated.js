export const ENCODINGS = [
    {
        "instructionId": "PRFM_reg",
        "encodingId": "PRFM_P_ldst_regoff",
        "mnemonic": "PRFM",
        "className": "Integer",
        "fileName": "prfm_reg.xml",
        "mask": 4292889600,
        "value": 4171253760,
        "bitCount": 14,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "option",
                        "mask": 2,
                        "lsb": 1,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    }
];
