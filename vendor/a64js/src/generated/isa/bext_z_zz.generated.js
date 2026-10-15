export const ENCODINGS = [
    {
        "instructionId": "bext_z_zz",
        "encodingId": "bext_z_zz_",
        "mnemonic": "BEXT",
        "className": "SVE2",
        "fileName": "bext_z_zz.xml",
        "mask": 4280351744,
        "value": 1157672960,
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
                "name": "opc",
                "lsb": 10,
                "width": 2
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
            "FEAT_SVE_BitPerm"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_BitPerm",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-binary"
    }
];
