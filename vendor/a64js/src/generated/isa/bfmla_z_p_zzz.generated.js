export const ENCODINGS = [
    {
        "instructionId": "bfmla_z_p_zzz",
        "encodingId": "bfmla_z_p_zzz_",
        "mnemonic": "BFMLA",
        "className": "SVE2",
        "fileName": "bfmla_z_p_zzz.xml",
        "mask": 4292927488,
        "value": 1696595968,
        "bitCount": 14,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fp-multiply-accumulate"
    }
];
