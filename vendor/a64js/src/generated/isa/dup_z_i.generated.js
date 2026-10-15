export const ENCODINGS = [
    {
        "instructionId": "dup_z_i",
        "encodingId": "dup_z_i_",
        "mnemonic": "DUP",
        "className": "SVE",
        "fileName": "dup_z_i.xml",
        "mask": 4282368000,
        "value": 624476160,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 17,
                "width": 2
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
        "operandFamilyId": "sve-dup-immediate"
    }
];
