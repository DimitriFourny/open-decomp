export const ENCODINGS = [
    {
        "instructionId": "ld1roh_z_p_br",
        "encodingId": "ld1roh_z_p_br_contiguous",
        "mnemonic": "LD1ROH",
        "className": "SVE",
        "fileName": "ld1roh_z_p_br.xml",
        "mask": 4292927488,
        "value": 2761949184,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "ssz",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_F64MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_F64MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-replicate-load"
    }
];
