export const ENCODINGS = [
    {
        "instructionId": "trn1_z_zz",
        "encodingId": "trn1_z_zz_q",
        "mnemonic": "TRN1",
        "className": "Even (quadwords)",
        "fileName": "trn1_z_zz.xml",
        "mask": 4292934656,
        "value": 94377984,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
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
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "trn1_z_zz",
        "encodingId": "trn2_z_zz_q",
        "mnemonic": "TRN2",
        "className": "Odd (quadwords)",
        "fileName": "trn1_z_zz.xml",
        "mask": 4292934656,
        "value": 94379008,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
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
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "trn1_z_zz",
        "encodingId": "trn1_z_zz_",
        "mnemonic": "TRN1",
        "className": "Even",
        "fileName": "trn1_z_zz.xml",
        "mask": 4280351744,
        "value": 86011904,
        "bitCount": 15,
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
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
            }
        ],
        "operandFamilyId": "sve-permutation"
    },
    {
        "instructionId": "trn1_z_zz",
        "encodingId": "trn2_z_zz_",
        "mnemonic": "TRN2",
        "className": "Odd",
        "fileName": "trn1_z_zz.xml",
        "mask": 4280351744,
        "value": 86012928,
        "bitCount": 15,
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
                "name": "H",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
            }
        ],
        "operandFamilyId": "sve-permutation"
    }
];
