export const ENCODINGS = [
    {
        "instructionId": "cpy_z_p_i",
        "encodingId": "cpy_z_p_i_",
        "mnemonic": "CPY",
        "className": "SVE",
        "fileName": "cpy_z_p_i.xml",
        "mask": 4281384960,
        "value": 84951040,
        "bitCount": 12,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Pg",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "M",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "sh",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "imm8",
                "lsb": 5,
                "width": 8
            },
            {
                "name": "Zd",
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "size",
                                "msb": 1,
                                "lsb": 0
                            },
                            {
                                "field": "sh",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-copy-merging-immediate"
    }
];
