export const ENCODINGS = [
    {
        "instructionId": "ldnf1sw_z_p_bi",
        "encodingId": "ldnf1sw_z_p_bi_s64",
        "mnemonic": "LDNF1SW",
        "className": "SVE",
        "fileName": "ldnf1sw_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2760941568,
        "bitCount": 15,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
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
        "operandFamilyId": "sve-fault-tolerant-load"
    }
];
