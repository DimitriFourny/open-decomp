export const ENCODINGS = [
    {
        "instructionId": "fmsb_z_p_zzz",
        "encodingId": "fmsb_z_p_zzz_",
        "mnemonic": "FMSB",
        "className": "SVE",
        "fileName": "fmsb_z_p_zzz.xml",
        "mask": 4280344576,
        "value": 1696636928,
        "bitCount": 12,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Za",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "N",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fmad"
    }
];
